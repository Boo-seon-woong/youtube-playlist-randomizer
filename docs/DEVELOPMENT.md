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
# node_modules는 지우면 안 된다 — 런타임 의존성(node-llama-cpp: 내장 번역 엔진, kuromoji: 일본어 발음 사전)이 들어있다.
# electron-packager --prune이 devDependencies를 알아서 뺀다. 다른 플랫폼 바이너리·테스트 파일만 정리:
APP="dist/YouTube Music Player-win32-x64/resources/app/node_modules"
find "$APP/@node-llama-cpp" -mindepth 1 -maxdepth 1 ! -name win-x64 -exec rm -rf {} +   # Windows CPU판(30MB)만 남김
rm -rf "$APP/kuromoji/test" "$APP/kuromoji/demo"
# 사전 준비(1회): node-llama-cpp의 Windows 바이너리는 리눅스 npm이 받지 않는다 —
#   mkdir -p node_modules/@node-llama-cpp/win-x64 && curl -sL https://registry.npmjs.org/@node-llama-cpp/win-x64/-/win-x64-<버전>.tgz | tar xz -C node_modules/@node-llama-cpp/win-x64 --strip-components=1
# 동봉 파일(gitignore — 저장소에는 없다, 없으면 그 기능만 꺼진다):
#   models/Hy-MT2-1.8B-IQ4_XS.gguf(986MB, 내장 번역) — https://huggingface.co/unsloth/Hy-MT2-1.8B-GGUF 의 IQ4_XS
#   models/ggml-small-q8_0.bin(264MB, 자동 싱크 음성 인식) — https://huggingface.co/ggerganov/whisper.cpp
#   asr/win-x64 — whisper.cpp b5130 whisper-bin-x64.zip의 Release/에서 whisper-cli.exe, whisper.dll, ggml*.dll
#   asr/win-x64-vk(그래픽카드 판) — CrispASR v0.8.41 crispasr-windows-x86_64-vulkan.zip의 crispasr.exe·crispasr.dll·ggml*.dll(+LICENSE)
#   (asr/linux-x64는 개발용 — package:win이 뺀다)
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

## GitHub Release 배포 (일반 사용자용 다운로드)

일반 사용자는 저장소를 클론하지 않고 Releases의 ZIP만 받도록 안내합니다 (README 최상단).

1. 위 절차로 패키징 + devDependencies 제거 + exe 아이콘 적용.
2. 패키징 폴더를 `YouTube Music Player/` 이름으로 zip:
   `zip -r9 YouTube-Music-Player-windows-x64.zip "YouTube Music Player"`
3. GitHub Release(태그 `vX.Y.Z`)를 만들고 ZIP을 자산으로 업로드.
   - **자산 파일명은 버전 없이 `YouTube-Music-Player-windows-x64.zip`으로 고정**합니다 —
     README의 원클릭 링크가 `releases/latest/download/<이 파일명>`을 가리키므로,
     이름을 유지해야 새 버전을 올릴 때마다 링크가 자동으로 최신을 가리킵니다.

동작 원리와 유튜브 관련 기술 제약은 [ARCHITECTURE.md](ARCHITECTURE.md)를 참고하세요.
