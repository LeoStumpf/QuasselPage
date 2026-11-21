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
