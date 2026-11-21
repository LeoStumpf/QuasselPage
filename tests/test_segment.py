from quasselpage.segment import chunk_for_tts, speakable, split_sentences


def texts(t):
    return [t[s:e] for s, e in split_sentences(t)]


def test_basic_sentences():
    assert texts("Hello world. This is Dr. Smith, e.g. a doctor. Is it? Yes!") == [
        "Hello world.", "This is Dr. Smith, e.g. a doctor.", "Is it?", "Yes!"]


def test_citation_moves_to_previous_sentence():
    t = 'It creates a "synthetic" voice output. [2] The quality is judged by similarity.'
    assert texts(t) == ['It creates a "synthetic" voice output. [2]', "The quality is judged by similarity."]


def test_spans_cover_original_text():
    t = "  First one.   Second one.  "
    assert [t[s:e] for s, e in split_sentences(t)] == ["First one.", "Second one."]


def test_speakable_strips_citations_and_urls():
    assert speakable("Shown in [12, 13] and https://example.org/x.") == "Shown in and link"


def test_long_sentence_is_chunked():
    long = ", ".join(["this is a fairly long clause"] * 30) + "."
    chunks = chunk_for_tts(long, 300)
    assert len(chunks) > 1 and all(len(c) <= 300 for c in chunks)
    assert " ".join(c.strip() for c in chunks).replace("  ", " ") == long
