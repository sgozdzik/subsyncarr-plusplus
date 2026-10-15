from claudesynchro.subtitles import Cue, clean_text, decode_bytes, parse_subtitles, read_subtitles, to_srt


def test_srt_roundtrip():
    text = "1\n00:00:01,000 --> 00:00:02,500\nCześć!\n<i>Jak się masz?</i>\n\n2\n00:01:00,100 --> 00:01:03,000\nDobrze.\n"
    cues, fmt = parse_subtitles(text)
    assert fmt == "srt"
    assert [(c.start, c.end) for c in cues] == [(1.0, 2.5), (60.1, 63.0)]
    assert cues[0].text == "Cześć!\n<i>Jak się masz?</i>"
    again, _ = parse_subtitles(to_srt(cues))
    assert [(c.start, c.end, c.text) for c in again] == [(c.start, c.end, c.text) for c in cues]


def test_srt_without_blank_separators():
    text = "1\n00:00:01,000 --> 00:00:02,000\nRaz\n2\n00:00:03,000 --> 00:00:04,000\nDwa\n"
    cues, _ = parse_subtitles(text)
    assert [c.text for c in cues] == ["Raz", "Dwa"]


def test_microdvd_with_declared_fps_and_formatting():
    text = "{1}{1}25\n{25}{50}{y:i}Pierwsza|druga linia\n{100}{}Bez końca\n"
    cues, fmt = parse_subtitles(text, fps=23.976)
    assert fmt == "microdvd"
    assert cues[0].start == 1.0 and cues[0].end == 2.0  # declared 25 fps wins
    assert cues[0].text == "<i>Pierwsza</i>\ndruga linia"
    assert cues[1].start == 4.0 and cues[1].end > cues[1].start


def test_mpl2_and_tmplayer():
    cues, fmt = parse_subtitles("[10][25]/Kursywa|Zwykła\n[30][40]Dalej\n")
    assert fmt == "mpl2"
    assert (cues[0].start, cues[0].end) == (1.0, 2.5)
    assert cues[0].text == "<i>Kursywa</i>\nZwykła"

    cues, fmt = parse_subtitles("00:00:05:Pierwsza linia\n00:00:09:Druga|linia\n")
    assert fmt == "tmplayer"
    assert cues[0].start == 5.0 and cues[0].end <= 9.0
    assert cues[1].text == "Druga\nlinia"


def test_ass():
    text = (
        "[Script Info]\nTitle: x\n\n[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
        "Dialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,{\\i1}Hej{\\i0}, to ja\\Nnowa linia\n"
    )
    cues, fmt = parse_subtitles(text)
    assert fmt == "ass"
    assert (cues[0].start, cues[0].end) == (1.5, 3.0)
    assert cues[0].text == "<i>Hej</i>, to ja\nnowa linia"


def test_polish_encodings_are_told_apart():
    sample = "Zażółć gęślą jaźń. Śmiało, Źdźbło! Ąę"
    for enc in ("cp1250", "iso-8859-2"):
        text, detected = decode_bytes(sample.encode(enc))
        assert text == sample, enc
        assert detected == enc
    text, detected = decode_bytes(sample.encode("utf-8"))
    assert text == sample and detected == "utf-8"


def test_read_file_cp1250(tmp_path):
    p = tmp_path / "film.txt"
    p.write_bytes("{24}{48}Jestem przerażona!\r\n{72}{96}Dlaczego?\r\n".encode("cp1250"))
    sub = read_subtitles(p, fps=24)
    assert sub.format == "microdvd" and sub.encoding == "cp1250"
    assert sub.cues[0].text == "Jestem przerażona!"


def test_clean_text():
    assert clean_text("- <i>Gdzie jest Anna?</i>\n- Nie wiem.") == "Gdzie jest Anna? Nie wiem."
    assert clean_text("JOHN: [door slams] Get out!") == "Get out!"
    assert clean_text("♪ ♪") == ""
    assert clean_text("{\\an8}Tekst") == "Tekst"


def test_cue_duration():
    assert Cue(1.0, 3.5, "x").duration == 2.5
