# claudesynchro benchmark

Synthetic films built from real English/Polish sentence pairs ([Tatoeba via OPUS](https://opus.nlpl.eu/Tatoeba/en&pl/v2023-04-12/Tatoeba), CC-BY 2.0 FR), with known ground truth for every line: frame-rate changes, ad breaks, extended video, extended subtitles, trimmed scenes, merged lines and Whisper-like transcript noise. alass (if installed) gets the same reference as a subtitle file.

```bash
mkdir -p data && curl -L -o data/tatoeba.zip https://object.pouta.csc.fi/OPUS-Tatoeba/v2023-04-12/moses/en-pl.txt.zip
(cd data && unzip -o tatoeba.zip)
python synthetic.py | python summarize.py          # all cases
python synthetic.py hard | python summarize.py     # only the hard ones
SEED_BASE=500 python synthetic.py | python summarize.py
```

The first run downloads the embedding model (~135 MB) into `~/.cache/claudesynchro`.
