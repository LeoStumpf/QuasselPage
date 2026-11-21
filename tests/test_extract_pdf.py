import pymupdf

from quasselpage.extract_pdf import extract_pdf


def make_pdf(path):
    doc = pymupdf.open()
    for i in range(4):
        page = doc.new_page(width=595, height=842)
        page.insert_text((72, 30), "Journal of Testing 2026", fontsize=9)       # repeated header
        page.insert_text((290, 820), str(i + 1), fontsize=9)                    # page number
        if i == 0:
            page.insert_text((72, 100), "The quick brown fox jumps over the inter-", fontsize=11)
            page.insert_text((72, 114), "national dog. A second sentence follows here.", fontsize=11)
        else:
            page.insert_text((72, 100), f"Page {i + 1} has its own sentence. It ends here.", fontsize=11)
    doc.save(path)


def test_extract(tmp_path):
    p = tmp_path / "t.pdf"
    make_pdf(p)
    d = extract_pdf(p)
    texts = [s["text"] for s in d["sentences"]]
    assert texts[0] == "The quick brown fox jumps over the international dog."
    assert texts[1] == "A second sentence follows here."
    assert not any("Journal of Testing" in t for t in texts), "header must be removed"
    assert not any(t.strip().isdigit() for t in texts), "page numbers must be removed"
    assert len(d["pages"]) == 4 and not d["scanned"]
    first = d["sentences"][0]
    assert first["page"] == 0 and len(first["rects"]) == 2           # spans two lines
    for s in d["sentences"]:
        for p_, x0, y0, x1, y1 in s["rects"]:
            assert 0 <= x0 < x1 <= 595 and 0 <= y0 < y1 <= 842
