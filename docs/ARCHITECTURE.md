# 아키텍처 및 기술 노트

## 구성 파일

| 파일 | 역할 |
|---|---|
| `main.js` | Electron 메인 프로세스 — 창 생성, 로컬 정적 서버, 재생목록 전곡 수집, 재생목록 메타(첫 곡·곡 수) 조회, 곡 제목 조회(oEmbed), 플레이리스트 저장 IPC, 광고 도메인 차단 |
| `preload.js` | contextBridge — 렌더러에 `store` / `titles` / `playlist` / `winctl` API 노출 |
| `renderer.js` | UI와 재생 로직 전부 — 자체 대기열, iframe 플레이어 제어, 폴백 재생, 몰입 모드, 사이드바 폴더 관리 |
| `index.html`, `styles.css` | 3열 레이아웃 (저장 목록 / 플레이어 / 대기열) |

## 사이드바 폴더 (playlists.json 구조)

저장된 재생목록은 Windows 탐색기처럼 드래그로 폴더에 정리할 수 있다.
폴더 안에 폴더를 넣을 수 있으며 중첩 깊이 제한은 없다 (`items`가 재귀 구조).

```json
[
  { "type": "playlist", "name": "이름", "url": "https://…list=PL…", "listId": "PL…" },
  { "type": "folder", "name": "폴더명", "open": true, "items": [ /* playlist 또는 folder 항목들 */ ] }
]
```

- HTML5 드래그 앤 드롭: 재생목록→재생목록 = 그 자리에 새 폴더로 묶기(즉시 이름 입력),
  재생목록/폴더→폴더 = 그 폴더 안으로 이동(폴더 중첩), 목록 빈 공간 = 루트로 이동.
  폴더를 자기 자신·자기 하위 폴더 안으로 넣는 순환은 `folderContains`로 차단한다.
- 렌더링은 재귀(`renderList` 안 `renderInto`)이며 들여쓰기는 깊이×18px 인라인 margin.
- `type` 없는 구버전 항목은 로드 시 `type:"playlist"`로 자동 마이그레이션 (`normalizeItems`, 재귀).
- 폴더 삭제 시 안의 항목은 한 단계 위(부모 배열의 그 자리)로 이동한다 (비파괴).
- 이름/링크는 연필 버튼의 인라인 폼으로 수정하며, 링크 수정 시 `listId`를 다시 추출한다.

### 재생목록 썸네일·곡 수 (`thumb` / `count` 필드)

각 재생목록 행에 첫 영상 썸네일(`i.ytimg.com/vi/<thumb>/mqdefault.jpg`)과 곡 수 배지를
표시한다. `playlist:meta` IPC(`fetchPlaylistMeta`)가 재생목록 페이지 **첫 페이지만** 요청해
첫 곡 ID와 총 곡 수를 얻고, 값은 `playlists.json`의 `thumb`/`count`에 캐시된다.

- 없는 항목만 앱 시작·추가 시 백그라운드로 수집하고, 재생 시 전곡 수집 결과로 최신화.
- 링크 수정으로 `listId`가 바뀌면 `thumb`/`count`를 비워 재수집한다.
- **곡 수 텍스트("동영상 N개")는 ytInitialData의 header 서브트리에서 문자열 완전일치로만
  찾는다** (`findVideoCountText`). 페이지 HTML 전체를 정규식으로 긁으면 UI 언어팩의
  "동영상 1개..." 같은 가짜 매치가 먼저 걸린다 (실제로 겪은 버그).

## 재생 구조: 자체 대기열

유튜브 iframe 플레이어의 내장 재생목록은 곡 삭제·순서 제어가 불가능하고 200곡까지만
노출된다. 그래서 앱은 **곡 ID 배열(대기열)을 직접 관리**하고, 재생은 곡 단위
`loadVideoById()`로 제어한다:

- 곡 종료(`ENDED`) → 다음 곡, 마지막 곡 이후 처음부터 반복
- `onError` → 폴백 재생으로 전환 (아래 참고)
- 셔플 = 배열 Fisher–Yates 셔플, 삭제 = `splice`

## 전곡 수집 (200곡 제한 우회)

`getPlaylist()`는 앞 200곡만 반환하므로, 재생목록 웹페이지의 `ytInitialData`를 파싱하고
InnerTube `youtubei/v1/browse` continuation을 끝까지 따라가 전곡(ID·제목·아티스트)을
가져온다. API 키 불필요 (페이지에 내장된 공개 키 사용).

- 2026-08 현재 페이지는 신형 **`lockupViewModel`** 구조를 사용한다
  (`contentId`, `lockupMetadataViewModel.title.content`,
  `metadataRows[0].metadataParts[0].text.content`). 구형 `playlistVideoRenderer`도 병행 지원.
- continuation 토큰은
  `continuationItemViewModel.continuationCommand.innertubeCommand.continuationCommand.token`처럼
  중첩 위치가 자주 바뀌므로 **심층 탐색으로 찾는다** (경로 하드코딩 금지).
- 수집 실패 시 iframe `cuePlaylist` → `getPlaylist()` 방식(최대 200곡)으로 자동 폴백.

## 개발 중 확인된 유튜브 제약 (경험적 사실)

- **오류 153**: referer 없는 `file://`에서 임베드 재생이 차단된다.
  → UI를 `http://127.0.0.1:<random port>` 내장 정적 서버로 서빙.
- **`loadPlaylist(ID배열)`은 현행 플레이어가 조용히 무시한다.** 배열 기반 재생목록 로드에
  의존하지 말 것.
- **oEmbed는 임베드 차단 영상에도 200을 반환**하므로 사전 감지에 쓸 수 없다.
  임베드 차단(오류 150)은 실제 로드 시 `onError`로만 확실히 알 수 있다 (반복 로드에도 재발화).
- Linux/WSLg에서 GPU 합성이 영상을 창 밖에 그리거나 검게 만든다
  → `app.disableHardwareAcceleration()` (Linux에서만).
- `hidden` 속성은 명시적 CSS `display` 규칙에 진다 → `[hidden] { display: none; }` 오버라이드 필요.

## 폴백 재생 (임베드 차단 곡)

임베드가 차단된 곡(오류 150)은 `<webview>`(같은 세션)로 **유튜브 워치페이지를 직접 열어**
재생한다. 브라우저로 youtube.com을 보는 것과 동일한 경로라 차단이 적용되지 않는다.

- 종료 감지: 1초 폴링으로 페이지 `<video>`의 `ended` / URL의 videoId 변경(자동재생 이탈)을
  감시. `.ad-showing`(광고 중)일 때는 종료 판정 보류 — 광고 종료를 곡 종료로 오인 방지.
- 페이지 상단바·댓글·추천 영역은 `insertCSS`로 숨겨 플레이어만 보이게.
- 워치페이지에서도 10초간 재생 시작 실패(삭제/비공개) → 재생 불가로 표시하고 스킵.
- 광고 자동 스킵: 100ms 인터벌 주입 스크립트 — `.ad-showing` 감지 시 무음 + 16배속 +
  광고 끝으로 점프(끝 시각을 모르는 광고도 배속으로 빨리 소진되고 스킵 카운트다운도 같이
  줄어든다), 스킵 버튼 계열 전부 자동 클릭, 프리미엄 팝업·"계속 시청" 확인창 자동 처리.
  광고 중에는 `insertCSS`의 `.ad-showing .html5-main-video { visibility: hidden }`로
  광고 영상 자체를 화면에서 숨긴다(검은 화면). DOM 셀렉터 기반이므로 유튜브 마크업 변경 시 갱신 필요.

## 몰입 모드 (앱이 직접 관리하는 전체화면)

전체화면은 앱이 소유한다: 컨트롤 바의 **전체화면** 버튼 → **창 전체화면 +
사이드바 숨김(body.immersive)**. 유튜브 자체(요소) 전체화면은 소유자가 iframe/webview라
임베드↔폴백 전환 때 풀리기 쉬워 진입 경로를 아예 막았다 — 임베드는 `fs=0`으로 버튼 제거,
폴백 워치페이지는 CSS로 `.ytp-fullscreen-button` 숨김. 몰입 모드는 임베드↔폴백을 오가도
유지되며, Esc 또는 우상단 버튼으로 해제한다.

- 남은 경로(워치페이지 키보드 `f`, 더블클릭 등)로 요소 전체화면이 시작되면
  `fullscreenchange` 리스너가 즉시 `absorbElementFullscreen()`으로 몰입 모드에 흡수한다.
- 웹뷰가 요소 전체화면을 쥔 채 `display:none`으로 숨겨지면 전체화면이 통째로 풀리기
  때문에, `stopFallback()`은 숨기기 **전에** 흡수를 호출한다.
- `exitFullscreen()`은 비동기다. 완료를 기다리지 않고 창 전체화면을 걸면 해제 완료 시점에
  창 상태까지 되돌아가 간헐적으로 전체화면이 풀린다 → `then()`으로 순서를 보장한다.

## 곡 제목·아티스트

- 1순위: 전곡 수집 시 페이지에서 한 번에 확보 (즉시 표시)
- 폴백: 유튜브 oEmbed(`youtube.com/oembed`) 곡별 조회 + `titles.json` 디스크 캐시
- 썸네일: `https://i.ytimg.com/vi/<id>/mqdefault.jpg`

## Windows 패키징

- `electron-packager` (win32/x64)는 WSL에서 wine 없이 동작하지만 exe 아이콘은 넣지 못함
  → Windows용 `rcedit-x64.exe`를 WSL interop으로 실행해 `--set-icon`.
  interop에서 cmd 따옴표가 잘 깨지므로 `.bat` 파일로 우회하는 것이 안전하다.
- `ELECTRON_RUN_AS_NODE=1 "YouTube Music Player.exe" script.js`로 패키징된 런타임에서
  Node 스크립트를 실행해 Windows 환경 검증에 활용 가능.
- 아이콘 생성 파이프라인: SVG → (Electron 내부 canvas 렌더링) 크기별 PNG →
  PNG 엔트리 ICO를 Node로 직접 패킹 (6바이트 헤더 + 16바이트 엔트리 × N + PNG 데이터).
