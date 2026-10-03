# 가사 정확도 측정용 시험 묶음: 유명 곡을 유튜브에서 검색해 상위 영상들의 실제 제목·채널·길이를 모은다.
# expected = (정답 곡명 키워드들, 정답 아티스트 키워드들) — 결과 판정에 쓴다.
import json, re, sys, urllib.parse, urllib.request

QUERIES = [
    # K-pop / 가요
    ("아이유 좋은 날", ["좋은 날", "good day"], ["아이유", "iu"]),
    ("BTS Dynamite official", ["dynamite"], ["bts", "방탄소년단"]),
    ("뉴진스 Hype Boy", ["hype boy"], ["newjeans", "뉴진스"]),
    ("IVE LOVE DIVE", ["love dive"], ["ive", "아이브"]),
    ("르세라핌 ANTIFRAGILE", ["antifragile"], ["le sserafim", "르세라핌"]),
    ("aespa Supernova", ["supernova"], ["aespa", "에스파"]),
    ("임영웅 사랑은 늘 도망가", ["사랑은 늘 도망가"], ["임영웅"]),
    ("AKMU 어떻게 이별까지 사랑하겠어 널 사랑하는 거지", ["어떻게 이별까지 사랑하겠어"], ["akmu", "악뮤", "악동뮤지션"]),
    ("윤하 사건의 지평선", ["사건의 지평선"], ["윤하", "younha"]),
    ("DAY6 한 페이지가 될 수 있게", ["한 페이지가 될 수 있게"], ["day6", "데이식스"]),
    ("BLACKPINK 뚜두뚜두", ["뚜두뚜두", "ddu-du ddu-du", "ddu du ddu du"], ["blackpink", "블랙핑크"]),
    ("10CM 봄이 좋냐", ["봄이 좋냐"], ["10cm", "십센치"]),
    # J-pop
    ("YOASOBI 夜に駆ける", ["夜に駆ける", "밤을 달리다", "yoru ni kakeru"], ["yoasobi", "요아소비"]),
    ("米津玄師 Lemon", ["lemon"], ["米津玄師", "요네즈 켄시", "kenshi yonezu"]),
    ("Ado うっせぇわ", ["うっせぇわ", "웃세와", "usseewa"], ["ado"]),
    ("Official髭男dism Pretender", ["pretender"], ["official髭男dism", "히게단", "officialhigedandism"]),
    ("King Gnu 白日", ["白日", "백일", "hakujitsu"], ["king gnu"]),
    ("優里 ドライフラワー", ["ドライフラワー", "드라이 플라워", "dry flower"], ["優里", "유우리", "yuuri"]),
    ("あいみょん マリーゴールド", ["マリーゴールド", "마리골드", "marigold"], ["あいみょん", "아이묭", "aimyon"]),
    ("ヨルシカ ただ君に晴れ", ["ただ君に晴れ", "그저 너에게 맑음"], ["ヨルシカ", "요루시카", "yorushika"]),
    ("LiSA 紅蓮華", ["紅蓮華", "홍련화", "gurenge"], ["lisa"]),
    ("Aimer 残響散歌", ["残響散歌", "잔향산가", "zankyosanka"], ["aimer"]),
    ("Mrs. GREEN APPLE ケセラセラ", ["ケセラセラ", "케세라세라", "que sera sera"], ["mrs. green apple", "mrs green apple"]),
    ("藤井風 死ぬのがいいわ", ["死ぬのがいいわ", "shinunoga e-wa"], ["藤井風", "fujii kaze", "후지이 카제"]),
    # 보컬로이드 / 버튜버
    ("ハチ 砂の惑星", ["砂の惑星", "모래의 혹성"], ["ハチ", "하치", "hachi", "米津玄師"]),
    ("DECO*27 ヴァンパイア", ["ヴァンパイア", "뱀파이어", "vampire"], ["deco*27", "deco27"]),
    ("星街すいせい Stellar Stellar", ["stellar stellar"], ["星街すいせい", "호시마치 스이세이", "hoshimachi suisei"]),
    ("Eve 廻廻奇譚", ["廻廻奇譚", "회회기담", "kaikaikitan"], ["eve"]),
    # 팝
    ("Ed Sheeran Shape of You", ["shape of you"], ["ed sheeran"]),
    ("The Weeknd Blinding Lights", ["blinding lights"], ["the weeknd"]),
    ("Billie Eilish bad guy", ["bad guy"], ["billie eilish"]),
    ("Bruno Mars Die With A Smile", ["die with a smile"], ["bruno mars", "lady gaga"]),
    ("Olivia Rodrigo drivers license", ["drivers license"], ["olivia rodrigo"]),
    ("Taylor Swift Anti-Hero", ["anti-hero", "anti hero"], ["taylor swift"]),
    # 번역/해석 채널식 제목
    ("요루시카 봄도둑 가사 해석", ["봄도둑", "春泥棒", "harudorobou"], ["요루시카", "ヨルシカ", "yorushika"]),
    ("한글자막 요네즈 켄시 Lemon", ["lemon"], ["米津玄師", "요네즈 켄시", "kenshi yonezu"]),
]

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"

def search(q):
    url = "https://www.youtube.com/results?hl=ko&search_query=" + urllib.parse.quote(q)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9", "Cookie": "CONSENT=YES+cb"})
    html = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "replace")
    m = re.search(r"var ytInitialData = (\{.*?\});</script>", html)
    data = json.loads(m.group(1))
    out = []
    def walk(n):
        if isinstance(n, dict):
            v = n.get("videoRenderer")
            if v and "lengthText" in v:
                t = "".join(r["text"] for r in v["title"]["runs"])
                ch = "".join(r["text"] for r in v.get("ownerText", {}).get("runs", []))
                parts = [int(x) for x in v["lengthText"]["simpleText"].split(":")]
                sec = parts[-1] + 60 * parts[-2] + (3600 * parts[-3] if len(parts) > 2 else 0)
                if 90 <= sec <= 600:
                    out.append({"id": v["videoId"], "title": t, "channel": ch, "duration": sec})
            for x in n.values(): walk(x)
        elif isinstance(n, list):
            for x in n: walk(x)
    walk(data)
    return out

corpus = []
for q, titles, artists in QUERIES:
    try:
        for v in search(q)[:2]:
            corpus.append({**v, "query": q, "expectTitles": titles, "expectArtists": artists})
    except Exception as e:
        print("fail", q, e, file=sys.stderr)
json.dump(corpus, open(sys.argv[1], "w"), ensure_ascii=False, indent=1)
print(len(corpus), "cases")
