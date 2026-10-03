# 사용자 플레이리스트 2개를 가사 실측용 묶음으로 수집: 영상 id·제목·채널·길이(초)
# 재생목록 웹 페이지의 ytInitialData + InnerTube browse 이어받기(continuation)로 전체 곡을 모은다.
import json, re, sys, urllib.request

LISTS = ["PL-gF1AzHbnB1NmbIKnCWNKWir8xqaL7CU", "PL-gF1AzHbnB1gt88pgVUdLiiuyyXuiXCe"]
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
HEAD = {"User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9", "Cookie": "CONSENT=YES+cb"}

def text(x):
    if not x: return ""
    if "simpleText" in x: return x["simpleText"]
    if "runs" in x: return "".join(r.get("text", "") for r in x["runs"])
    if "content" in x: return x["content"]
    return ""

def collect(node, out, tokens):
    if isinstance(node, dict):
        v = node.get("playlistVideoRenderer")
        if v and v.get("videoId"):
            out.append({"id": v["videoId"], "title": text(v.get("title")), "channel": text(v.get("shortBylineText")),
                        "duration": int(v.get("lengthSeconds") or 0)})
        lv = node.get("lockupViewModel")
        if lv and lv.get("contentType") == "LOCKUP_CONTENT_TYPE_VIDEO":
            meta = lv.get("metadata", {}).get("lockupMetadataViewModel", {})
            title = meta.get("title", {}).get("content", "")
            rows = meta.get("metadata", {}).get("contentMetadataViewModel", {}).get("metadataRows", [])
            ch = rows[0]["metadataParts"][0]["text"]["content"] if rows and rows[0].get("metadataParts") else ""
            # 길이는 썸네일 배지("3:45")에 있다
            dur = 0
            badge = re.search(r'"text":\s*"((?:\d+:)?\d{1,2}:\d{2})"', json.dumps(lv.get("contentImage", {}), ensure_ascii=False))
            if badge:
                parts = [int(x) for x in badge.group(1).split(":")]
                dur = parts[-1] + 60 * parts[-2] + (3600 * parts[-3] if len(parts) > 2 else 0)
            out.append({"id": lv.get("contentId"), "title": title, "channel": ch, "duration": dur})
        ci = node.get("continuationItemRenderer")
        if ci:
            # 새 UI는 commandExecutorCommand 안에 토큰을 넣는다 — 경로를 고정하지 말고 깊이 찾는다
            def find_tok(n):
                if isinstance(n, dict):
                    cc = n.get("continuationCommand")
                    if isinstance(cc, dict) and cc.get("token"): return cc["token"]
                    for x in n.values():
                        t = find_tok(x)
                        if t: return t
                elif isinstance(n, list):
                    for x in n:
                        t = find_tok(x)
                        if t: return t
                return None
            tok = find_tok(ci)
            if tok: tokens.append(tok)
        for x in node.values(): collect(x, out, tokens)
    elif isinstance(node, list):
        for x in node: collect(x, out, tokens)

def fetch_list(list_id):
    html = urllib.request.urlopen(urllib.request.Request(f"https://www.youtube.com/playlist?list={list_id}&hl=ko", headers=HEAD), timeout=30).read().decode()
    key = re.search(r'"INNERTUBE_API_KEY":"([^"]+)"', html).group(1)
    ver = re.search(r'"INNERTUBE_CLIENT_VERSION":"([^"]+)"', html).group(1)
    data = json.loads(re.search(r"var ytInitialData = (\{.*?\});</script>", html).group(1))
    out, tokens = [], []
    collect(data, out, tokens)
    # 토큰 위치가 자주 바뀌므로 응답 전체에서 continuationCommand 토큰을 모두 모아 시도한다
    tokens += re.findall(r'"continuationCommand":\s*\{\s*"token":\s*"([^"]+)"', html)
    seen_tok = set()
    while tokens:
        tok = tokens.pop(0)
        if tok in seen_tok: continue
        seen_tok.add(tok)
        body = json.dumps({"context": {"client": {"clientName": "WEB", "clientVersion": ver, "hl": "ko"}}, "continuation": tok}).encode()
        req = urllib.request.Request(f"https://www.youtube.com/youtubei/v1/browse?key={key}", data=body, headers={**HEAD, "Content-Type": "application/json"})
        raw = urllib.request.urlopen(req, timeout=30).read().decode()
        d = json.loads(raw)
        tokens += re.findall(r'"continuationCommand":\s*\{\s*"token":\s*"([^"]+)"', raw)
        collect(d, out, tokens)  # 섹션(추천) 토큰은 영상을 안 주지만 멈추지 않고 다음 토큰으로
        if len(seen_tok) > 40: break
    return out

corpus = []
seen = set()
for lid in LISTS:
    items = fetch_list(lid)
    print(lid, len(items), "items", file=sys.stderr)
    for it in items:
        if it["id"] in seen: continue
        seen.add(it["id"])
        corpus.append({**it, "list": lid})
json.dump(corpus, open(sys.argv[1], "w"), ensure_ascii=False, indent=1)
print(len(corpus), "unique videos")
