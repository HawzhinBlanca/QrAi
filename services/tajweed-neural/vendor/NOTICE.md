# Vendored third-party code

`modeling_multi_level_ctc.py`, `configuration_multi_level_ctc.py`,
`multi_level_tokenizer.py`, `vocab.py` are vendored (unmodified) from
**obadx/prepare-quran-dataset** (https://github.com/obadx/prepare-quran-dataset),
which implements the `Wav2Vec2BertForMultilevelCTC` architecture for the
`obadx/muaalem-model-v3` neural tajweed model. License: MIT (see upstream repo).
Paper: arXiv:2509.00094. Vendored so the model loads under a standard transformers
release without depending on the upstream training package.
