"""UgaJapa Bot ù NLLB-200 translation engine (internal only, port 8000)."""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from transformers import pipeline
import torch

app = FastAPI(title="UgaJapa Translation Bot")

LANG_CODES = {
    "en": "eng_Latn",   # English
    "ja": "jpn_Jpan",   # Japanese
    "lg": "lug_Latn",   # Luganda
    "fr": "fra_Latn",   # French
    "sw": "swh_Latn",   # Swahili
    "ach": "ach_Latn",  # Acholi
}

MODEL_NAME = "facebook/nllb-200-distilled-600M"

translator = None


def get_translator():
    global translator
    if translator is None:
        translator = pipeline(
            "translation",
            model=MODEL_NAME,
            device=0 if torch.cuda.is_available() else -1,
        )
    return translator


class TranslateRequest(BaseModel):
    text: str
    from_lang: str
    to_lang: str


@app.on_event("startup")
def load_model():
    get_translator()


@app.get("/health")
def health():
    return {"status": "ok", "engine": MODEL_NAME.split("/")[-1]}


@app.post("/translate")
def translate(req: TranslateRequest):
    if req.from_lang == req.to_lang:
        return {"translated": req.text, "engine": "none"}

    if req.from_lang not in LANG_CODES:
        raise HTTPException(status_code=400, detail=f"Unsupported from_lang: {req.from_lang}")
    if req.to_lang not in LANG_CODES:
        raise HTTPException(status_code=400, detail=f"Unsupported to_lang: {req.to_lang}")

    if not req.text or not req.text.strip():
        raise HTTPException(status_code=400, detail="text must not be empty")

    try:
        result = get_translator()(
            req.text,
            src_lang=LANG_CODES[req.from_lang],
            tgt_lang=LANG_CODES[req.to_lang],
            max_length=512,
        )
        return {
            "translated": result[0]["translation_text"],
            "engine": MODEL_NAME.split("/")[-1],
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Translation failed: {e}") from e


@app.get("/languages")
def languages():
    return {"languages": list(LANG_CODES.keys())}
