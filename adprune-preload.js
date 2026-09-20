// 워치페이지(폴백 웹뷰) 프리로드 — 광고를 "막는" 대신 플레이어 응답에서 광고 데이터를 걷어낸다.
//
// 유튜브는 광고 요청이 실패하는 것(네트워크 차단)과 재생 중인 광고를 조작하는 것(무음·배속·점프)을
// 감지해 "서비스 약관을 위반하는 광고 차단 프로그램" 화면으로 재생 자체를 막는다. 반면 플레이어가
// 받은 JSON에서 adPlacements/playerAds/adSlots를 지우면 플레이어는 광고의 존재를 아예 모르므로
// 광고가 재생되지 않고(기다릴 시간도 없다), 차단된 요청도 조작된 재생도 없어 감지할 거리가 없다.
// Brave·uBO가 유튜브에 쓰는 방식과 같다.
//
// 이 파일은 페이지 스크립트보다 먼저 실행돼야 하므로 webview preload로 붙이며,
// 페이지와 같은 JS 월드에 있어야 전역을 가로챌 수 있어 contextIsolation을 끈 채로 쓴다
// (main.js의 will-attach-webview에서 설정).

(() => {
  const AD_KEYS = ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams'];

  function prune(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    for (const key of AD_KEYS) {
      if (key in obj) {
        try { delete obj[key]; } catch {}
      }
    }
    // /next·watch 응답은 플레이어 응답을 한 겹 감싸서 준다
    if (obj.playerResponse) prune(obj.playerResponse);
    if (obj.player && obj.player.playerResponse) prune(obj.player.playerResponse);
    return obj;
  }

  // ① 최초 로드: 인라인 스크립트의 `var ytInitialPlayerResponse = {...}`.
  // 전역에 접근자를 먼저 정의해 두면 var 선언은 기존 접근자를 덮지 않고 대입만 setter로 들어온다.
  let initialPlayerResponse;
  try {
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get: () => initialPlayerResponse,
      set: (value) => { initialPlayerResponse = prune(value); },
    });
  } catch {}

  // ② 곡이 바뀔 때(SPA)나 플레이어가 새로 받아오는 /youtubei/v1/player 응답
  const nativeParse = JSON.parse;
  JSON.parse = function (text, reviver) {
    return prune(nativeParse.call(this, text, reviver));
  };

  if (window.Response && Response.prototype && Response.prototype.json) {
    const nativeJson = Response.prototype.json;
    Response.prototype.json = function (...args) {
      return nativeJson.apply(this, args).then(prune);
    };
  }
})();
