from quasselpage.extract_web import from_html, from_text

HTML = """<html><head><title>Test Article</title></head><body>
<nav>Home | About</nav>
<article><h1>Test Article</h1>
<p>This is the first paragraph of a reasonably long article. It contains two sentences.</p>
<p>The second paragraph talks about something <b>else</b> entirely. Then it ends.</p>
<ul><li>A list item with text.</li></ul>
</article><footer>Copyright</footer></body></html>"""


def test_from_html():
    d = from_html(HTML, "https://example.org/a")
    texts = [s["text"] for s in d["sentences"]]
    assert "This is the first paragraph of a reasonably long article." in texts
    assert "The second paragraph talks about something else entirely." in texts
    assert 'data-s="0"' in d["html"]
    assert d["sentences"][-1]["para_end"]


def test_from_text():
    d = from_text("One. Two.\n\nThree.", "T")
    assert [s["text"] for s in d["sentences"]] == ["One.", "Two.", "Three."]
    assert [s["para_end"] for s in d["sentences"]] == [False, True, True]


def test_absolutize_css():
    from quasselpage.extract_web import absolutize_css
    css = 'a{background:url(img/x.png)} b{src:url("data:font/woff2;base64,AA")} @import "more.css";'
    out = absolutize_css(css, "https://example.org/static/site.css")
    assert 'url("https://example.org/static/img/x.png")' in out
    assert 'url("data:font/woff2;base64,AA")' in out
    assert '@import "https://example.org/static/more.css"' in out


def test_prepare_original_strips_active_content():
    from quasselpage.extract_web import prepare_original
    raw = """<html><head><meta charset="latin1"><base href="/docs/"><script>alert(1)</script></head>
    <body onload="x()"><a href="javascript:evil()">x</a><iframe src="https://ads.example"></iframe>
    <p>Hello <b>world</b>.</p></body></html>"""
    out = prepare_original(raw, "https://example.org/a/page")
    assert "<script" not in out and "<iframe" not in out
    assert "onload" not in out and "javascript:" not in out
    assert '<base href="https://example.org/docs/">' in out
    assert 'name="referrer" content="no-referrer"' in out
    assert "<p>Hello <b>world</b>.</p>" in out
