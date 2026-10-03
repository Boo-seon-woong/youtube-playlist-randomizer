# 재개 문서 — 가사 검색 개선 · 발음 표기 · 번역 (2026-10-04 중단)

사용자가 "20분 안에 마무리하거나, 안 되면 나중에 재개할 수 있도록 문서화하고 멈추라"고 해서 멈춘 지점.
코드는 작업 브랜치 `wip/lyrics-overhaul`에 커밋되어 있고 **아직 배포(로컬 설치본·GitHub 릴리스)하지 않았다**
— 실제 앱으로 한 번도 돌려 보지 않은 변경이 많기 때문. 설치본·릴리스는 v1.31.0 그대로다.

## 사용자 요청 (원문 요지)

1. 가사 검색이 불안정 — 유명한 곡도 못 찾거나, 같은 곡이 찾아졌다 말았다 함(예: 아이리 칸나 최종화), 다른 곡이 연결됨.
   알송에 없으면 탐색 수단을 늘리고, 알송에 있는 곡은 확실히 찾을 것. 목표는 "최대화".
2. 가사 찾는 시간이 너무 김 — 적중률을 떨어뜨리지 않는 선에서 최적화.
3. 싱크 없는 가사로 자동 싱크가 가능하면 하고, 불가능하면 포기하되 본문만이라도 보여 줄 것
   (메인 창은 마우스 스크롤, 플로팅 창은 Alt+Z/Alt+X).
4. Alt+A/D 방향 맞바꾸기, 싱크 보정 ±10초 제한 제거, Alt+S로 원래 싱크.
5. 외국어만 있는 가사에 한글 발음 표기, 표시 방식 선택(번역/발음), 영어는 둘 다 제외. 기계 번역이 제대로 되는 걸 본 적 없음.
6. 번역 모델 교체(더 작고 품질 좋은 최신 모델). 곡 중간에 번역을 켜고 끄면 즉시 반영.
7. 판정은 정답표 대신 **LLM(Claude)이 결과를 직접 읽고** 할 것 — 음악 카드 같은 휴리스틱을 정답 기준으로 쓰지 말 것.
   참고 재생목록: `PL-gF1AzHbnB1NmbIKnCWNKWir8xqaL7CU`(56곡), `PL-gF1AzHbnB1gt88pgVUdLiiuyyXuiXCe`(482곡).

## 구현 완료 (브랜치에 커밋, 앱 실행 검증 전)

- `lyrics-search.js` 분리, 알송 동시 4개 제한 + 3회 재시도(타임아웃 3초), 실패 시 캐시 안 함·15초 뒤 재시도.
- 캐시 키를 영상 id로 고정(제목 갈림 버그), 원어 제목을 `altTitle`로 받아 검색어에 병합.
- 출처 동시 조회(알송·LRCLIB·NetEase), 알송 한글+가수 일치 시 즉시 반환, 음악 카드 우선, 본문 교차 검증
  (통과한 커버 등록본은 표기만 참조 곡으로), 제목 해석 보강(THE FIRST TAKE·연도·「」·CJK 하이픈·두 언어 병기·
  설명 문장), 싱크 없는 가사 폴백.
- 다음 곡 가사 미리 찾기(`lyrics:prefetch`, 재생목록 항목에 `seconds`), 진행 중 검색 공유(`searchLyricsShared`).
- 싱크 없는 가사 UI: 플로팅 창 Alt+Z/X(`lyrics:scroll`) + "싱크 없음" 배지, 메인 창 가사 보기 휠 스크롤.
- Alt+A=늦게 / Alt+D=빠르게, 보정 제한 없음, Alt+S 원래대로.
- `pronounce.js`(kuromoji) 일본어 → 한글 발음, 워커 `type:'pron'` 잡. `foreignMode` 설정(pron 기본 / pron+tr / tr / off),
  `augmentForeignLyrics`가 발음·번역을 원문 아래 줄로 붙임. 모드 변경 시 `reapplyForeignMode` → 즉시 재적용,
  진행 중 번역은 `cancelForeignWork`로 취소(워커 `type:'cancel'`), 번역은 한 줄마다 바로 표시.
- 번역 루프 방지: `repetition_penalty 1.3`, `no_repeat_ngram_size 3`, 길이 상한, 반복 후처리, 의성어 줄 생략, 캐시 `mt-cache-v2`.

## 측정 결과 (지금까지)

- 알송 동시 16개 → 16/32 타임아웃, 4개 이하 → 0건. 수정 후 아이리 칸나 5/5 동일 결과, 요청 실패 0.
- 69곡 묶음(유명 곡, `test/lyrics-eval/corpus.json`) 기준선(배포본 로직 + 신뢰성 수정): 정답 60 / 다른 곡 7 / 못 찾음 2.
  새 로직 스폿 체크: 아도 うっせぇわ(THE FIRST TAKE 번역 채널 제목) 0.2초 정답, 아이리 칸나 0.1초 정답.
- 재생목록 536곡: 배포본(v1.31.0) 로직은 3병렬로 30분에 다 못 끝냄(곡당 평균 10초+). 새 로직 부분 결과
  `test/lyrics-eval/result-new-partial.jsonl`(약 100곡): 92% 발견, 중간값 1.1초 — 단 알송이 막힐 때 상위 10%가
  60초(알송 타임아웃·재시도; 이후 타임아웃 5초→3초로 줄임, 재측정 필요 — 이날 시험으로 알송에 요청을 수천 건
  보내 일시 제한이 걸렸을 가능성도 있다). **아직 결과를 직접 읽고 판정하지 않았다.**
- 번역 모델(Windows 설치본 런타임에서 실측): M2M100-418M q8 = 로드 3.2초, 줄당 0.5~1초, RSS 1.7GB, 품질 거침,
  사용자 PC `mt-cache`에 "나 나 나 …" 수백 번 반복 같은 고장 출력 다수(그래서 "제대로 되는 걸 본 적 없다").
  후보 시험(`test/lyrics-eval/llm-test.js`): Gemma 3 270M q4(483MB RSS) — 엉뚱한 번역 + 덧붙임,
  Qwen2.5 0.5B int8(1.46GB, 줄당 3~4초) — 가사와 무관한 문장 생성, Qwen3 0.6B int8(1.69GB, 줄당 5.4초) —
  thinking이 꺼지지 않아 번역 대신 추론 출력. **셋 다 탈락 — 아직 교체 모델 없음.**

## 남은 일 (순서대로)

1. 새 로직으로 재생목록 536곡 전체 측정 — 결과를 한 곡씩 JSONL로 이어 쓰므로 구간을 나눠 돌린다(한 번에 돌리면
   백그라운드 실행 한도 약 30분에 걸림, 구간당 180곡도 한도에 걸렸으니 60~90곡 단위 권장):
   `cd test/lyrics-eval && node run-playlists.js new2 --cards --from 0 --to 90` (이어서 90~180 …)
   → `node table.js new2 0 90` 식으로 표를 뽑아 **직접 읽고** 곡마다 정답/다른 곡/못 찾음(있을 법한지) 판정.
   필요하면 기준선: `node run-playlists.js old --module ./old-lyrics-search.js --old-fallback --step 3`.
2. 판정에서 나온 실패 유형별로 `lyrics-search.js` 수정 → 같은 곡들로 재측정(회귀 확인).
   알송이 계속 느리면 검색어 조합 탐색(`fetchAlsongCandidates`, 현재 순차)을 2개씩 동시에 하는 것도 검토.
3. 번역 모델 후속 후보: NLLB-200-distilled-600M(2022, 품질은 M2M100보다 낫다고 알려짐 — 크기·속도 실측 필요),
   Opus-MT 피벗(ja→en→ko, Marian ~300MB×2), Qwen3 0.6B는 chat 템플릿에서 thinking을 확실히 끈 뒤 재시험
   (`tokenizer.apply_chat_template(..., { enable_thinking: false })` 직접 호출). 조건: 지금보다 작고(디스크 < 600MB,
   RAM < 1.7GB) 번역이 더 자연스러울 것. 못 찾으면 현 모델 + 반복 방지로 유지.
   시험 스크립트는 Windows 설치본 실행 파일을 Node 모드로 써서 돌린다(아래 llm-test.js 머리 주석 참고):
   `cd "/mnt/c/Users/boosu/Desktop/YouTube Music Player" && ELECTRON_RUN_AS_NODE=1 WSLENV=ELECTRON_RUN_AS_NODE/w ./"YouTube Music Player.exe" 'C:\Users\boosu\AppData\Local\Temp\ymp-dbg\llm-test.js' <모델> <dtype>`
   (스크립트를 그 Windows 경로에 복사해 둘 것 — WSL 쪽 transformers는 sharp 리눅스 바이너리가 없어 import 실패).
4. 앱 실제 실행 검증(WSLg): 싱크 없는 가사 스크롤, Alt+Z/X, 발음 줄 표시, 표시 방식 전환 즉시 반영/취소,
   다음 곡 미리 찾기(곡 전환 직후 가사가 바로 뜨는지), 볼륨·EQ(이전 작업) 회귀 없음.
5. 버전 올림(1.32.0) → main에 병합·푸시 → 패키징(트림 목록에 kuromoji test/demo 추가됨) → 로컬 설치본 rsync
   → GitHub 릴리스(고정 자산명). 절차는 CLAUDE.md·메모리 `local-deploy-procedure`.
