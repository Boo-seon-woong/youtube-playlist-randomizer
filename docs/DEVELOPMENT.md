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
# node_modules는 지우면 안 된다 — 런타임 의존성(@huggingface/transformers, 동봉 번역 모델용)이 들어있다.
# electron-packager --prune이 devDependencies를 알아서 뺀다. 다른 플랫폼 바이너리만 정리:
rm -rf "dist/YouTube Music Player-win32-x64/resources/app/node_modules/onnxruntime-node/bin/napi-v6/linux" \
       "dist/YouTube Music Player-win32-x64/resources/app/node_modules/onnxruntime-node/bin/napi-v6/darwin" \
       "dist/YouTube Music Player-win32-x64/resources/app/node_modules/@img/sharp-linux-x64" \
       "dist/YouTube Music Player-win32-x64/resources/app/node_modules/@img/sharp-libvips-linux-x64"
# 사전 준비(1회): sharp의 win32 바이너리 강제 설치 — npm install --no-save --force --os=win32 --cpu=x64 sharp
# 번역 모델은 ./models/(gitignore, 611MB)에 동봉된다. 없으면:
#   node --input-type=module -e "import {pipeline,env} from '@huggingface/transformers'; env.cacheDir='./models'; await pipeline('translation','Xenova/m2m100_418M',{dtype:'q8'})"
# (env.allowRemoteModels 기본값이 true인 상태로 위를 실행하면 HuggingFace에서 받아 models/에 캐시된다)
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
