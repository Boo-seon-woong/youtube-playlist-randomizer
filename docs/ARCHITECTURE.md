# 아키텍처 및 기술 노트

## 구성 파일

| 파일 | 역할 |
|---|---|
| `main.js` | Electron 메인 프로세스 — 창 생성, 로컬 정적 서버, 재생목록 전곡 수집, 재생목록 메타(첫 곡·곡 수) 조회, 곡 제목 조회(oEmbed), 플레이리스트·디자인 설정 저장 IPC, 광고 도메인 차단(웹뷰 제외), 구글 계정 연동(로그인 창·계정 재생목록·곡 추가)·유튜브 검색 |
| `preload.js` | contextBridge — 렌더러에 `store` / `titles` / `playlist` / `uiSettings` / `winctl` / `account` / `ytsearch` API 노출 |
| `renderer.js` | UI와 재생 로직 전부 — 자체 대기열, iframe 플레이어 제어, 폴백 재생, 몰입 모드, 사이드바 폴더 관리, 우클릭 컨텍스트 메뉴, 계정 섹션·검색 패널 |
| `index.html`, `styles.css` | Spotify를 참고한 다크 테마 — 상단 바(로고·검색·계정) + 검은 프레임 위 패널 3개(저장 목록 / 플레이어 / 대기열) + 하단 전폭 재생 바 |

## 사이드바 폴더 (playlists.json 구조)

저장된 재생목록은 Windows 탐색기처럼 드래그로 폴더에 정리할 수 있다.
폴더 안에 폴더를 넣을 수 있으며 중첩 깊이 제한은 없다 (`items`가 재귀 구조).

```json
[
  { "type": "playlist", "name": "이름", "url": "https://…list=PL…", "listId": "PL…" },
  { "type": "folder", "name": "폴더명", "open": true, "items": [ /* playlist 또는 folder 항목들 */ ] }
]
```

- **새 폴더는 우클릭 컨텍스트 메뉴로 원하는 위치에 바로 만든다** (`createFolder(arr, index)`):
  폴더 행 → 그 폴더 안, 재생목록 행 → 같은 위치(바로 아래), 목록 빈 공간·상단 + 버튼 → 최상위.
  어느 경로든 만들자마자 인라인 이름 입력으로 들어간다. 재생목록 행 메뉴에는 재생/셔플/수정/삭제도 있다.
- HTML5 드래그 앤 드롭은 **드롭 위치로 의미가 갈린다** (`dropZoneFor`):
  행의 **위/아래 가장자리 25%**에 놓으면 단순 **순서 이동**(그 행의 앞/뒤에 삽입 — 같은 배열이든
  다른 폴더든 대상 행이 속한 위치로 이동, 삽입선으로 표시), 행 **가운데 50%**에 완전히 겹치면
  **병합** — 재생목록→재생목록 = 그 자리에 새 폴더로 묶기(즉시 이름 입력),
  재생목록/폴더→폴더 = 그 폴더 안으로 이동(폴더 중첩). 목록 빈 공간 = 루트로 이동.
  폴더→재생목록은 가장자리(순서 이동)만 허용된다. 순서 이동 삽입 시 **source를 먼저 제거한 뒤
  target 위치를 다시 찾아야** 같은 배열 안에서 인덱스가 밀리지 않는다.
  폴더를 자기 자신·자기 하위 폴더 안으로 넣는 순환은 `folderContains`로 차단한다.
- 렌더링은 재귀(`renderList` 안 `renderInto`)이며 들여쓰기는 깊이×24px 인라인 margin.
- 폴더 열림/닫힘 상태는 별도 caret 없이 **아이콘 모양(닫힌 폴더 ↔ 열린 폴더)**으로 표시한다
  (caret 컬럼을 두면 같은 깊이의 재생목록 행과 정렬이 어긋난다).
- `type` 없는 구버전 항목은 로드 시 `type:"playlist"`로 자동 마이그레이션 (`normalizeItems`, 재귀).
- 폴더 삭제 시 안의 항목은 한 단계 위(부모 배열의 그 자리)로 이동한다 (비파괴).
- 이름/링크는 연필 버튼의 인라인 폼으로 수정하며, 링크 수정 시 `listId`를 다시 추출한다.

### 재생목록 썸네일·곡 수 (`thumb` / `count` 필드)

각 재생목록 행에 첫 영상 썸네일(`i.ytimg.com/vi/<thumb>/mqdefault.jpg`)과
부제("재생목록 · N곡")를 표시한다. `playlist:meta` IPC(`fetchPlaylistMeta`)가 재생목록 페이지 **첫 페이지만** 요청해
첫 곡 ID와 총 곡 수를 얻고, 값은 `playlists.json`의 `thumb`/`count`에 캐시된다.

- 없는 항목만 앱 시작·추가 시 백그라운드로 수집하고, 재생 시 전곡 수집 결과로 최신화.
- 링크 수정으로 `listId`가 바뀌면 `thumb`/`count`를 비워 재수집한다.
- **곡 수 텍스트("동영상 N개")는 ytInitialData의 header 서브트리에서 문자열 완전일치로만
  찾는다** (`findVideoCountText`). 페이지 HTML 전체를 정규식으로 긁으면 UI 언어팩의
  "동영상 1개..." 같은 가짜 매치가 먼저 걸린다 (실제로 겪은 버그).

## 재생목록 곡 구성 보기 (사이드바 클릭 ≠ 재생)

사이드바 행을 클릭하면 바로 재생하지 않고 **중앙(플레이어 위 오버레이 `#browse-panel`)에 곡
구성만** 보여준다. 재생 중인 대기열(셔플 순서 포함)을 덮어쓰지 않고 다른 재생목록을 살펴보기
위한 것으로, 오른쪽 대기열 패널은 항상 "지금 재생 중인 것"만 가리킨다.

- `openBrowse(pl)`이 재생과 같은 스트리밍 수집(`fetchFirst` → `fetchMore` 반복)으로 곡을 받아
  도착하는 대로 행을 이어 붙인다(`appendBrowseRows` — 배치마다 전체 재렌더 없음). `browseToken`으로
  닫기/다른 목록 열기 시 진행 중인 수집을 중단한다.
- 오버레이는 `#search-panel`과 같은 z-index 층에 DOM상 앞에 두어 검색 패널이 위에 그려진다.
  영상 요소는 그대로 아래에 있으므로 재생은 끊기지 않는다.
- 화면의 **재생 / 셔플 재생** 버튼, 또는 곡 행 클릭(그 곡부터 순서대로)이 `playFromBrowse` →
  `playPlaylist(listId, shuffle, preset)`를 부른다. 전곡을 이미 받았으면 `preset.items`로 넘겨
  **재수집 없이** 즉시 대기열을 만들고, `preset.startId`로 시작 곡을 정한다. `playPlaylist`는
  시작 시 `closeBrowse()`로 오버레이를 닫아 중앙을 영상으로 되돌린다.
- 대기열 곡 클릭·검색/추천의 "지금 재생"·몰입 모드 진입도 오버레이를 닫는다. 자동 다음 곡 진행은
  닫지 않는다 (목록을 읽는 중 곡이 바뀌어도 화면이 튀지 않도록).
- 행의 셔플 아이콘과 우클릭 메뉴의 재생/셔플 재생은 예전처럼 즉시 재생하는 지름길로 남겨 두었다.

## 재생 구조: 자체 대기열

유튜브 iframe 플레이어의 내장 재생목록은 곡 삭제·순서 제어가 불가능하고 200곡까지만
노출된다. 그래서 앱은 **곡 ID 배열(대기열)을 직접 관리**하고, 재생은 곡 단위
`loadVideoById()`로 제어한다:

- 곡 종료(`ENDED`) → 다음 곡, 마지막 곡 이후 처음부터 반복
- `onError` → 폴백 재생으로 전환 (아래 참고)
- 워치독 2단: 8초째 시작 못 함(state -1/5) 또는 **15초째 버퍼링(state 3)에서 진행 0**
  → 폴백 재생으로 전환 ("아예 재생이 안 되는 곡" 방지)
- 셔플 = 배열 Fisher–Yates 셔플, 삭제 = `splice`

## 전곡 수집 (200곡 제한 우회, 스트리밍 로드)

`getPlaylist()`는 앞 200곡만 반환하므로, 재생목록 웹페이지의 `ytInitialData`를 파싱하고
InnerTube `youtubei/v1/browse` continuation을 따라가 전곡(ID·제목·아티스트)을 가져온다.
API 키 불필요 (페이지에 내장된 공개 키 사용).

**전곡 완료를 기다리지 않는다** — 첫 페이지(~100곡)가 도착하면 그 즉시 대기열을 만들어
재생/셔플을 시작하고(`playlist:fetchFirst`), 나머지는 continuation을 백그라운드로 반복 호출해
(`playlist:fetchMore`) 도착하는 대로 대기열에 이어 붙인다. 453곡 기준 클릭→재생이
약 3초→1.7초로 단축 (재생목록이 길수록 격차 커짐, 100곡당 continuation ~0.5초).

- 셔플 재생 중 뒤늦게 도착한 곡은 **아직 재생하지 않은 구간에 무작위 삽입**된다.
- 로드 도중 다른 재생목록을 시작하면 `loadToken` 불일치로 이어받기 루프가 중단된다.
- 곡 수 배지/썸네일 메타는 전곡 확보 후에 갱신·저장한다.
- 대기열 썸네일은 `loading=lazy`라 원래 비동기 — 로드 속도의 병목은 continuation 대기였다.
- 2026-08 현재 페이지는 신형 **`lockupViewModel`** 구조를 사용한다
  (`contentId`, `lockupMetadataViewModel.title.content`,
  `metadataRows[0].metadataParts[0].text.content`). 구형 `playlistVideoRenderer`도 병행 지원.
- continuation 토큰은
  `continuationItemViewModel.continuationCommand.innertubeCommand.continuationCommand.token`처럼
  중첩 위치가 자주 바뀌므로 **심층 탐색으로 찾는다** (경로 하드코딩 금지).
- 첫 페이지 수집 실패 시 iframe `cuePlaylist` → `getPlaylist()` 방식(최대 200곡)으로 자동 폴백.

## 구글 계정 연동 (게스트 모드 ↔ 로그인)

기본 상태는 **게스트 모드**다 — 로컬 `playlists.json`의 링크만으로 동작하며 상단 바에
"게스트 모드" 배지와 **로그인** 버튼이 보인다. 로그인해도 로컬 목록은 그대로 유지되고,
그 **위에** 계정 섹션("내 YouTube 플레이리스트")이 추가로 표시될 뿐이다.

- **로그인 방식**: OAuth/API 키 없이, 별도 `BrowserWindow`로 구글 로그인 페이지를 띄워
  사용자가 직접 로그인하게 한다. 구글은 임베디드 브라우저 로그인을 차단하는데 **크롬 UA
  위장으로는 부족**하다(Sec-CH-UA·크롬 전용 API 검사 — 실측). 그래서 로그인 흐름 전체에
  **Firefox UA + Sec-CH-UA 헤더 제거**(accounts.*는 항상, 나머지 구글 도메인은 로그인 창
  요청만) + `AutomationControlled` 비활성화를 적용한다. 그래도 구글이 간헐적으로 거부할 수
  있으며(구글 공식 안내는 OAuth/PWA 전환 — GCP 클라이언트 ID가 필요해 본 앱 설계와 충돌),
  재시도하면 성공한다. `SAPISID` 쿠키가 생기면 성공으로 판단하고 1.5초 뒤 창을 닫는다.
- **로그인 유지**: 쿠키는 기본 세션에 저장되어 재시작 후에도 유지된다. 크로미움의 지연
  저장 때문에 로그인 직후 앱을 닫으면 유실될 수 있어 **로그인 성공 직후와 종료 전에
  `cookies.flushStore()`로 즉시 디스크에 기록**한다 — 한 번 성공하면 계속 로그인 상태.
- **인증 호출**: 이후의 유튜브 요청은 웹 클라이언트와 동일한
  `Authorization: SAPISIDHASH <ts>_<SHA1(ts + SAPISID + origin)>` + `Cookie` + `X-Origin`
  헤더로 인증한다(`authHeaders()`). 이 헤더는 **기존 재생목록 수집·메타 조회에도 항상
  섞어 보내므로**, 로그인하면 비공개 재생목록(나중에 볼 동영상 WL, 좋아요 LL 포함)도 재생된다.
- **계정 재생목록**: `feed/playlists` 페이지의 ytInitialData + `browse` continuation으로
  전체 목록(제목·썸네일·곡 수)을 수집한다. 신형 `lockupViewModel`(LOCKUP_CONTENT_TYPE_PLAYLIST)과
  구형 `gridPlaylistRenderer` 병행 지원. 계정 목록은 **playlists.json에 저장하지 않고**
  실행/로그인 때마다 새로 불러온다(원본이 유튜브 계정이므로). 사이드바에서 드래그·수정·삭제
  대상이 아니며 재생/셔플만 가능.
- **검색**: 상단 바 검색창 → InnerTube `search`(동영상 필터, 비로그인도 동작) → 결과를
  플레이어 위 오버레이로 표시. 곡 단위로 **지금 재생**(현재 곡 다음에 삽입) / **대기열에
  추가** / (로그인 시) **계정 재생목록에 추가**를 지원한다.
- **곡 추가**: InnerTube `browse/edit_playlist`(`ACTION_ADD_VIDEO`) — 유튜브 웹의
  "재생목록에 저장"과 동일한 엔드포인트. 좋아요 목록(LL)은 이 API로 추가할 수 없어 대상에서 제외.
- **로그아웃**: 세션 쿠키 전체 삭제(`clearStorageData`) → 게스트 모드로 복귀.
- InnerTube API 키/클라이언트 버전은 유튜브 홈 페이지에서 1회 추출해 캐시(`getInnertubeCfg`).

## 추천 곡 ("맞춤 동영상")

하단 재생 바의 별 버튼으로 여닫는 하단 패널. **현재 재생 중인 재생목록의 유튜브
"맞춤 동영상" 섹션**(재생목록 페이지에 나오는 그 추천)을 가로 스크롤 카드로 보여준다.

- **데이터 출처**: 재생목록 browse(`VL<listId>`) 응답에는 continuation 토큰이 둘 있다 —
  하나는 영상 목록(다음 100곡, `playlistVideoListRenderer` 서브트리 안), 다른 하나는
  섹션 continuation으로 이 쪽이 "맞춤 동영상" 섹션을 싣는다. `findRecsToken`은
  playlistVideoListRenderer 밖에 있는 토큰(=섹션 토큰)을 골라, 그것을 따라가 추천 영상을 얻는다.
- **새로고침**: 같은 섹션 토큰을 다시 부르면 유튜브가 **매번 다른 추천 묶음**을 준다 —
  새로고침은 이 성질을 그대로 쓴다(`next`로 섹션 토큰을 그대로 돌려줌). 응답 안의 continuation을
  이어받으면 안 된다 — 영상 목록 쪽으로 흘러 재생목록에 이미 있는 곡만 오게 된다(겪은 버그).
- **watch next 폴백은 쓰지 않는다**: 재생목록 곡의 관련 동영상(`next`)을 모아 채우는 방식을
  넣었다가, 재생목록과 연관성이 낮은 영상이 섞이는 문제로 제거했다. "맞춤 동영상" 섹션이 없는
  재생목록(비소유·공개, 로그아웃)은 부적절한 대체 대신 안내 문구만 띄운다.
- **제약**: "맞춤 동영상"은 사실상 **로그인한 사용자 소유 재생목록**에서만 제공된다. 공개·타인
  재생목록은 이 섹션이 없어 추천이 비며, 그 경우 "이 재생목록은 유튜브 맞춤 추천을 제공하지
  않습니다"(로그아웃 시 로그인 안내)를 보여준다.
- 이미 대기열에 있는 곡은 목록에서 제외한다. 카드: 클릭=지금 재생(현재 곡 다음에 삽입),
  호버 버튼=대기열 추가 / (로그인 시) 내 재생목록 추가.

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
- **contextBridge 전역과 같은 이름의 최상위 `let`은 SyntaxError를 낸다** ("Identifier 'account'
  has already been declared") — 렌더러 스크립트 전체가 실행되지 않는다. 브리지 이름과 렌더러
  상태 변수 이름을 겹치지 않게 할 것 (`window.account` ↔ `accountState`).
- **iframe API 로드 경쟁**: 캐시된 리로드에서는 `www-widgetapi`가 renderer.js보다 먼저 실행을
  끝내 `onYouTubeIframeAPIReady`가 영영 불리지 않을 수 있다 → 콜백 정의 직후
  `window.YT && YT.Player`면 직접 호출하는 가드 필요.
- **광고 도메인을 워치페이지(webview)에서까지 차단하면 유튜브가 광고 차단으로 감지**해
  "광고 차단 프로그램은 YouTube에서 허용되지 않습니다" 팝업으로 재생을 정지시킨다
  → 차단은 임베드(메인 창)에만 적용하고 웹뷰 요청은 통과시킨다(광고는 주입 스크립트가 소화).
- **임베드가 버퍼링(state 3)에서 진행 0인 채 영영 멈추는 곡**이 있다(스트림 차단/오류) —
  `onError`도 오지 않아 상태 기반 워치독(-1/5)에 안 걸린다 → 15초 진행 없으면 폴백 전환.

## 폴백 재생 (임베드 차단 곡)

임베드가 차단된 곡(오류 150)은 `<webview>`(같은 세션)로 **유튜브 워치페이지를 직접 열어**
재생한다. 브라우저로 youtube.com을 보는 것과 동일한 경로라 차단이 적용되지 않는다.

- 종료 감지: 1초 폴링으로 페이지 `<video>`의 `ended` / URL의 videoId 변경(자동재생 이탈)을
  감시. `.ad-showing`(광고 중)일 때는 종료 판정 보류 — 광고 종료를 곡 종료로 오인 방지.
- 페이지 상단바·댓글·추천 영역은 `insertCSS`로 숨기고, 플레이어(`#movie_player`)는
  `position: fixed` + `100vw/100vh`로 **웹뷰 뷰포트 전체에 고정**한다. 페이지 배치 크기
  그대로면 몰입(전체화면) 시 화면을 꽉 채우지 못한다. 크기 강제 후에는 주입 스크립트가
  `resize` 이벤트를 디스패치해 유튜브가 영상/컨트롤 크기를 다시 계산하게 한다.
- 워치페이지에서도 10초간 재생 시작 실패(삭제/비공개) → 재생 불가로 표시하고 스킵.
- 광고 자동 스킵: 100ms 인터벌 주입 스크립트 — `.ad-showing` 감지 시 무음 + 16배속 +
  광고 끝으로 점프(끝 시각을 모르는 광고도 배속으로 빨리 소진되고 스킵 카운트다운도 같이
  줄어든다), 프리미엄 팝업·"계속 시청" 확인창 자동 처리.
  광고 중에는 `insertCSS`의 `.ad-showing .html5-main-video { visibility: hidden }`로
  광고 영상 자체를 화면에서 숨긴다(검은 화면).
- 스킵 버튼 클릭은 **2중 경로**: 클래스 셀렉터에 더해 플레이어 안 버튼의 텍스트/aria-label
  ("건너뛰기"/"Skip")로도 찾아 클릭하고(전면 스폰서 카드처럼 영상이 없어 배속이 안 통하는
  형태 대비), 페이지 내 `click()`은 유튜브가 신뢰되지 않은 이벤트로 무시할 수 있으므로
  버튼 좌표를 `__skipRect`에 남기면 렌더러가 300ms 폴링으로 소비해 main이
  `webContents.sendInputEvent`로 **신뢰된 실제 마우스 클릭**을 보낸다. 클릭 직전
  `elementFromPoint`로 그 좌표가 여전히 스킵 버튼인지 재검증해 낡은 좌표 오클릭을 막는다.
  DOM 셀렉터 기반이므로 유튜브 마크업 변경 시 갱신 필요.
- **광고 차단 감지 팝업 대응(2중)**: ① 광고 도메인 차단을 웹뷰 요청에는 적용하지 않아
  감지 자체를 피하고(main의 `onBeforeRequest`가 `webContentsId`로 웹뷰를 예외 처리),
  ② 그래도 팝업(`ytd-enforcement-message-view-renderer`)이 뜨면 주입 스크립트가 닫기 버튼을
  자동 클릭하고 5초 안에 재생을 재개한다. 팝업은 닫힐 때까지 CSS로 숨긴다.

## 몰입 모드 (앱이 직접 관리하는 전체화면)

전체화면은 앱이 소유한다: 컨트롤 바의 **전체화면** 버튼 또는 **f 키** → **창 전체화면 +
사이드바 숨김(body.immersive)**. 유튜브 자체(요소) 전체화면은 소유자가 iframe/webview라
임베드↔폴백 전환 때 풀리기 쉬워 진입 경로를 아예 막았다 — 임베드는 `fs=0`으로 버튼 제거,
폴백 워치페이지는 CSS로 `.ytp-fullscreen-button` 숨김. 몰입 모드는 임베드↔폴백을 오가도
유지되며, f/Esc 또는 우상단 버튼으로 해제한다.

- **f 키 토글**: 앱 화면에서는 렌더러 `keydown`(입력창 타이핑 중에는 무시), 폴백 워치페이지
  안에서는 main의 `before-input-event`가 f를 가로채(`preventDefault`로 유튜브 자체 전체화면
  단축키 선점) 렌더러에 토글을 전달한다. 임베드 iframe 내부에 포커스가 있을 때는 크로스오리진
  OOPIF라 가로채지 못해 f가 동작하지 않을 수 있다 (그 경우도 요소 전체화면은
  fullscreenchange 흡수로 몰입 모드가 된다).
- **해제 버튼 자동 숨김**: 몰입 모드에서 마우스가 2.5초간 멈추면 `.idle`로 투명해진다.
  마우스가 iframe/webview 위에 있으면 DOM mousemove가 호스트에 오지 않으므로, 커서 화면
  좌표를 IPC(`window:cursor`, `screen.getCursorScreenPoint`)로 500ms 폴링해 감지한다.

- 남은 경로(워치페이지 키보드 `f`, 더블클릭 등)로 요소 전체화면이 시작되면
  `fullscreenchange` 리스너가 즉시 `absorbElementFullscreen()`으로 몰입 모드에 흡수한다.
- 웹뷰가 요소 전체화면을 쥔 채 `display:none`으로 숨겨지면 전체화면이 통째로 풀리기
  때문에, `stopFallback()`은 숨기기 **전에** 흡수를 호출한다.
- `exitFullscreen()`은 비동기다. 완료를 기다리지 않고 창 전체화면을 걸면 해제 완료 시점에
  창 상태까지 되돌아가 간헐적으로 전체화면이 풀린다 → `then()`으로 순서를 보장한다.

## 하단 재생 바 (현재 곡 표시)

화면 하단 전폭 바에 현재 곡 썸네일·제목·아티스트와 셔플/이전/다음 버튼, 오른쪽에
추천/사운드 세팅(+볼륨 슬라이더)/디자인 설정/전체화면 버튼을 표시한다.

- 표시 갱신은 `setNowPlaying(id, title, author, badge)` 단일 진입점 — 임베드 재생은
  `onStateChange`의 `getVideoData()`로, 폴백 재생은 `startFallback`이 titleCache로 채운다
  (폴백은 "직접 재생" 배지 표시).
- **폴백 재생 중에는 iframe의 잔여 상태 변화를 무시한다** (`fallbackActive` 가드) —
  `stopVideo()` 등이 발화시키는 onStateChange가 폴백 곡 표시·배지를 덮어쓰는 것 방지.

## 디자인 설정 (테마 커스터마이징)

하단 재생 바의 톱니 버튼 → 모달에서 테마를 바꾼다 (Slack의 테마 설정 참고).

- 저장 값은 **기본 3색뿐**: `settings.json` = `{ accent, base, panel }` (+ 사운드 세팅의
  `volume` — 아래 섹션). 나머지 표면 색(hover·active·input·tile)은 styles.css의
  `color-mix()`가 패널 색에서 파생하므로 어떤 색을 골라도 단계가 자동으로 맞는다.
- 적용은 renderer `applyTheme()`이 `documentElement` 인라인 스타일로 `--accent`/`--bg-base`/`--panel`을
  덮어쓰는 방식. 프리셋 6종 + `input[type=color]` 3개(input 이벤트로 실시간 미리보기,
  change에서 저장) + 기본 테마 복원 버튼.
- 포인트 색은 **대기 상태에서도 보이도록** 저장 버튼(CTA)·사이드바 헤더 아이콘·입력창 포커스
  테두리·대기열 곡 수 pill에 쓰고, 재생 중에는 활성 재생목록·현재 곡 강조에 쓴다.
  포인트 색 위 글자색은 `--on-accent` — `applyTheme()`이 포인트 색 상대 명도(< 0.2 → 흰색,
  아니면 검정)로 정한다. 배경/패널만 바꾸는 테마와 달리 포인트 색만 달라도 구분돼야 한다.
- **localStorage를 쓰지 않는 이유**: UI 서버 포트가 실행마다 랜덤이라 오리진이 바뀌어
  localStorage가 유지되지 않는다 → `settings:load/save` IPC로 파일에 저장.

## 패널 접기 / 폭 조절 (사이드바·대기열)

`#app`은 `사이드바 | .resizer | 플레이어 | .resizer | 대기열`의 flex 행이고, 패널 사이 8px
간격 자체가 폭 조절 핸들(`.resizer`)이다. 핸들 가운데의 알약 버튼(`.resizer-btn`, ‹ ›)이
접기/펼치기 토글 — 접힌 상태에서도 핸들과 버튼은 남아 있어 언제든 다시 펼칠 수 있다.

- 상태는 `layout = { sidebarWidth, queueWidth, sidebarCollapsed, queueCollapsed }` 하나로,
  `settings.json`의 `layout`에 저장 (테마·볼륨과 한 객체). `applyLayout()`이 인라인 `width`와
  `body.sidebar-collapsed` / `body.queue-collapsed` 클래스, 버튼 아이콘·툴팁을 갱신한다.
- 드래그는 Pointer Events + `setPointerCapture`. **드래그 중 `body.resizing`이 `#content`의
  `pointer-events`를 끈다** — 마우스가 임베드 iframe/폴백 webview 위를 지나면 이벤트가 그쪽으로
  넘어가 드래그가 끊기기 때문. 폭은 `PANEL_LIMITS`(사이드바 200~520, 대기열 220~560)와
  창 폭의 45%로 클램프되어 플레이어가 짓눌리지 않는다. 접힌 패널의 핸들은 드래그를 무시한다.
- 몰입 모드에서는 핸들도 함께 숨긴다 (`body.immersive .resizer`).
- **영상 최소화** (`layout.centerMin`, 하단 바 최소화 버튼): 좌우 패널을 접듯 중앙을 화면 구성에서
  없앤다. `body.center-min`에서 `#content`를 **폭 0**(`flex: 0 0 0; overflow: hidden`)으로 접고
  대기열(사이드바가 접혔으면 사이드바)이 `flex: 1`로 그 자리를 채운다. 두 핸들이 나란히 붙으므로
  각 4px로 줄여 경계 하나처럼 보이게 하고 접기 버튼은 위(사이드바 ‹)·아래(대기열 ›)로 어긋나게 둔다.
  **`display: none`이 아니라 폭 0인 이유**: 직접 재생 webview는 레이아웃에서 빠지면 게스트가 끊긴다 —
  폭 0이면 임베드·폴백 모두 소리가 이어진다(임베드는 실측으로 확인). 곡 구성·검색 오버레이는 플레이어
  영역 안에 그려지므로 열 때 `setCenterMin(false)`로 자동으로 다시 펼치고, 몰입 모드 진입도 펼친다.
  최소화 중 재생목록을 틀 수 있도록 사이드바 행에 재생/셔플 버튼(hover 표시)이 있다.

## 사운드 세팅 (앱 마스터 볼륨)

유튜브 볼륨은 임베드 플레이어와 워치페이지가 **따로 기억해** 일반 재생↔직접 재생 전환 때마다
따로 논다 → 앱이 볼륨의 단일 기준이 된다. 하단 재생 바의 슬라이더(스피커 버튼 왼쪽) 또는
스피커 버튼 → 사운드 세팅 모달에서 조절한다.

- 값은 `masterVolume` (0.00 ~ 100.00, 소숫점 둘째자리) 하나 — `settings.json`의 `volume`으로
  저장되어 재시작 후에도 유지. 슬라이더는 input(실시간 반영)/change(저장) 분리.
- **임베드**: IFrame API `player.setVolume(masterVolume)` — onReady·곡 로드(`playCurrent`)·
  볼륨 변경 시 재적용. API가 정수로 반올림하므로 소숫점은 근사 적용된다.
  **볼륨 0에서 `unMute()`를 호출하면 플레이어가 최소 볼륨 5로 되살린다(실측)** — 그래서
  0.5 미만(반올림 시 0)은 `player.mute()`로 명시적 음소거, 그 이상만 `unMute()`한다.
- **직접 재생(폴백)**: dom-ready와 볼륨 변경 시 `window.__appVolume`을 주입하고, 광고 스킵용
  100ms 인터벌이 광고 중이 아닐 때 `video.volume`을 `__appVolume/100`으로 **계속 강제**한다
  — 워치페이지 자체 볼륨 슬라이더 조작도 앱 볼륨으로 되돌아온다 (소숫점까지 정확).
  광고 중 무음 처리는 `muted`라 볼륨 강제와 충돌하지 않는다.
- 사운드 세팅 모달은 EQ 그래프 스타일(세로 눈금 + 포인트색 라인/면 그라디언트 + 링 노브)
  — 정밀 조절용 `step 0.01` 슬라이더와 소숫점 둘째자리 실수 직접 입력 필드 제공.
  하단 바 슬라이더는 `step 1`(빠른 조절용). f 키 전체화면 토글은 INPUT 포커스를 무시하지만
  볼륨 슬라이더(`type=range`)는 예외로 허용.

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
- 앱 로고(2026-08 교체): 녹색(#1DB954) 라운드 사각 타일 + 검정 사운드바 3개(왼쪽부터 낮아지며
  재생 방향을 암시), 플랫·무그라데이션. Python PIL로 4096px에 그려 LANCZOS 다운스케일 →
  `icon.png`(256) + `icon.ico`(16~256 멀티사이즈 PNG 엔트리). 상단 바의 브랜드 마크는 같은
  사운드바 모티프의 인라인 SVG로, 색은 테마 포인트 색(`--accent`)을 따른다.
