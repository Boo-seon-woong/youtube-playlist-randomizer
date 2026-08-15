# 빌드 및 패키징

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

## exe 아이콘 넣기 (WSL, wine 불필요)

Linux에서 electron-packager는 exe 아이콘을 넣지 못하므로, Windows용 `rcedit`를
WSL interop으로 실행해 넣습니다:

```
rcedit-x64.exe "...\YouTube Music Player.exe" --set-icon icon.ico
```

- `icon.ico` / `icon.png`는 저장소 루트에 포함되어 있습니다.
- interop에서 cmd 따옴표가 깨지기 쉬우므로 `.bat` 파일로 감싸 실행하는 것이 안전합니다.
- 아이콘 교체 후 탐색기·검색에 옛 아이콘이 보이면 Windows 아이콘 캐시 때문입니다.
  앱을 새 파일로 재배포하면 다시 인덱싱됩니다.

동작 원리와 유튜브 관련 기술 제약은 [ARCHITECTURE.md](ARCHITECTURE.md)를 참고하세요.
