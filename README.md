# YouTube Music Player

유튜브 재생목록 링크를 붙여넣어 음악과 영상을 감상하는 Windows/Linux 데스크톱 플레이어입니다.
Electron 기반이며, 유튜브 로그인·API 키 없이 동작합니다. 미디어 파일을 내려받지 않고
재생목록 **링크만** 로컬에 저장·관리합니다.

![스크린샷](docs/screenshot.png)

## 주요 기능

- **재생목록 링크 재생** — `youtube.com/playlist?list=...`, `watch?v=...&list=...` 링크나 재생목록 ID를 붙여넣으면 영상과 함께 재생
- **전곡 로드** — iframe 플레이어의 200곡 제한 없이 재생목록 전체(수백 곡)를 불러옴
- **셔플 재생** — 재생목록 단위 셔플 시작, 재생 중에는 현재 곡을 유지한 채 나머지만 다시 섞기
- **재생 대기열 패널** — 순번·썸네일·곡 제목·아티스트 표시, 현재 곡 하이라이트,
  곡 클릭으로 즉시 이동, 곡별 삭제(휴지통) 버튼
- **플레이리스트 로컬 저장** — 이름을 붙여 저장/삭제, JSON 파일로 관리 (미디어 저장 없음)
- **임베드 차단 곡 폴백 재생** — 업로더가 외부 임베드를 차단한 곡은 내장 브라우저 뷰로
  유튜브 워치페이지를 직접 열어 재생 (대기열에 "직접 재생" 배지 표시)
- **광고 처리** — 광고 도메인 네트워크 차단 + 폴백 모드에서 영상 광고 자동 스킵(무음 처리 후
  끝으로 점프), 스킵 버튼·프리미엄 팝업·"계속 시청" 확인창 자동 처리
- **몰입 모드** — 전체화면 시청 중 임베드↔폴백 전환이 일어나도 전체화면이 끊기지 않음
  (Esc 또는 우상단 버튼으로 해제)
- **재생 불가 곡 처리** — 삭제/비공개 영상은 회색·취소선으로 표시하고 자동 스킵,
  이전/다음 이동도 건너뜀
- **자동 진행** — 곡 종료 시 다음 곡 자동 재생, 마지막 곡 이후 처음부터 반복

## 개발 환경에서 실행

```bash
npm install
npm start        # 내부적으로 electron . --no-sandbox
```

- Node.js 20+ 필요. WSL2에서는 WSLg로 창이 표시됩니다 (root 실행 때문에 `--no-sandbox` 사용).
- Linux/WSLg에서는 GPU 합성 버그 방지를 위해 하드웨어 가속이 자동으로 비활성화됩니다
  (Windows 네이티브에서는 가속 사용).

## Windows 실행 파일 만들기

```bash
npm run package:win
# → dist/YouTube Music Player-win32-x64/YouTube Music Player.exe
rm -rf "dist/YouTube Music Player-win32-x64/resources/app/node_modules"   # 불필요한 devDependencies 제거
```

만들어진 폴더를 통째로 Windows 쪽에 복사하면 `YouTube Music Player.exe` 더블클릭으로 실행됩니다.

### exe 아이콘 넣기 (WSL, wine 불필요)

Linux에서 electron-packager는 exe 아이콘을 넣지 못하므로, Windows용 `rcedit`를
WSL interop으로 실행해 넣습니다:

```
rcedit-x64.exe "...\YouTube Music Player.exe" --set-icon icon.ico
```

`icon.ico` / `icon.png`는 저장소에 포함되어 있습니다.

## 데이터 저장 위치

| 항목 | 위치 |
|---|---|
| 저장한 플레이리스트 | `%APPDATA%\youtube-music-player\playlists.json` (Windows) / `~/.config/youtube-music-player/playlists.json` (Linux) |
| 곡 제목 캐시 | 같은 폴더의 `titles.json` |

## 제한 사항

- 유튜브 웹 구조에 의존하는 부분(전곡 수집, 광고 스킵)은 유튜브 개편 시 손봐야 할 수 있습니다.
  전곡 수집이 실패하면 iframe 방식(최대 200곡)으로 자동 폴백합니다.
- 폴백(직접 재생) 모드는 실제 유튜브 페이지이므로 광고가 잠깐(무음) 스칠 수 있습니다.
- 삭제·비공개·지역 차단 영상은 재생할 수 없으며 자동 스킵됩니다.

기술적인 동작 원리와 개발 중 확인된 유튜브 제약 사항은 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)를 참고하세요.
