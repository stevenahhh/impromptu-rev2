"""Tesseract TSV parsing and Hangul-aware OCR line reconstruction."""

from dataclasses import dataclass

from impromptu_ingestion.adapters.base import StructuralExtractionError
from impromptu_ingestion.contracts import TextElement

# Tesseract emits one TSV word per tracked glyph group; wide letter tracking on
# Korean slide titles splits single words into several "words" that we would
# otherwise rejoin with spaces. Measured on real decks, spurious intra-word
# gaps stay under ~0.25x of the glyph height while genuine word spaces start
# around ~0.45x, so gaps at or below this fraction of the glyph height are
# treated as letter spacing, not word boundaries.
_HANGUL_JOIN_GAP_RATIO = 0.35
_TIGHT_JOIN_GAP_RATIO = 0.10
# Tokens below this confidence are hallucinations when they carry no Hangul
# (stray Latin fragments from chart grids); confident punctuation-only tokens
# are dropped regardless.
_MIN_TOKEN_CONFIDENCE = 30.0
_REQUIRED_TSV_COLUMNS = {
    "level",
    "page_num",
    "block_num",
    "par_num",
    "line_num",
    "left",
    "top",
    "width",
    "height",
    "text",
}


def ocr_unavailable(detail: str) -> StructuralExtractionError:
    return StructuralExtractionError("ocr_unavailable", f"scanned_page_requires_ocr: {detail}")


@dataclass(frozen=True)
class _Word:
    line_key: tuple[int, int, int, int]
    text: str
    left: int
    top: int
    right: int
    bottom: int
    conf: float


def _is_hangul_syllable(character: str) -> bool:
    return "가" <= character <= "힣"


def _carries_content(token: str) -> bool:
    # Hangul compatibility jamo (ㄴㄴ, ㅡ ...) count as alphanumeric in Unicode
    # but are OCR grid debris here; only ASCII alphanumerics or real Hangul
    # syllables count as content.
    return any(
        (character.isascii() and character.isalnum()) or _is_hangul_syllable(character)
        for character in token
    )


def _is_single_syllable(token: str) -> bool:
    return len(token) == 1 and _is_hangul_syllable(token)


def _joins_without_space(previous: _Word, following: _Word) -> bool:
    if not (_is_hangul_syllable(previous.text[-1]) and _is_hangul_syllable(following.text[0])):
        return False
    gap = max(0, following.left - previous.right)
    height = min(previous.bottom - previous.top, following.bottom - following.top)
    if height <= 0 or gap > _HANGUL_JOIN_GAP_RATIO * height:
        return False
    return (
        _is_single_syllable(previous.text)
        or _is_single_syllable(following.text)
        or gap <= _TIGHT_JOIN_GAP_RATIO * height
    )


def _integer(value: str | None) -> int | None:
    try:
        return int(value) if value is not None else None
    except ValueError:
        return None


def parse_words(tsv: bytes) -> list[_Word]:
    try:
        text = tsv.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ocr_unavailable("Tesseract returned non-UTF-8 TSV") from error
    if not text.strip():
        raise ocr_unavailable("Tesseract returned empty TSV")

    # Tesseract occasionally emits a token whose text starts with a quote
    # character; a CSV reader treats it as an opening quote and swallows every
    # following TSV row into one field, leaking raw rows into extracted text.
    # TSV has no quoting semantics, so split strictly on newlines and tabs.
    rows = [row.split("\t") for row in text.splitlines()]
    header = rows[0] if rows else []
    if not _REQUIRED_TSV_COLUMNS.issubset(header):
        raise ocr_unavailable("Tesseract returned empty TSV")
    column = {name: index for index, name in enumerate(header)}

    def field(row: list[str], name: str) -> str | None:
        index = column[name]
        return row[index] if index < len(row) else None

    words: list[_Word] = []
    for row in rows[1:]:
        value = (field(row, "text") or "").strip()
        level = _integer(field(row, "level"))
        left = _integer(field(row, "left"))
        top = _integer(field(row, "top"))
        width = _integer(field(row, "width"))
        height = _integer(field(row, "height"))
        page_num = _integer(field(row, "page_num"))
        block_num = _integer(field(row, "block_num"))
        par_num = _integer(field(row, "par_num"))
        line_num = _integer(field(row, "line_num"))
        conf_field = field(row, "conf")
        try:
            conf = float(conf_field) if conf_field is not None else -1.0
        except ValueError:
            conf = -1.0
        if (
            level != 5
            or not value
            or left is None
            or top is None
            or width is None
            or height is None
            or width <= 0
            or height <= 0
            or page_num is None
            or block_num is None
            or par_num is None
            or line_num is None
        ):
            continue
        # Drop obvious noise without inventing content: punctuation/symbol-only
        # tokens (chart grid lines, rules) and sub-threshold non-Hangul debris.
        if not _carries_content(value):
            continue
        if conf < _MIN_TOKEN_CONFIDENCE and not any(
            _is_hangul_syllable(character) for character in value
        ):
            continue
        words.append(
            _Word(
                line_key=(page_num, block_num, par_num, line_num),
                text=value,
                left=max(0, left),
                top=max(0, top),
                right=max(0, left + width),
                bottom=max(0, top + height),
                conf=conf,
            )
        )
    if not words:
        raise ocr_unavailable("Tesseract returned empty TSV")
    return words


def line_elements(
    words: list[_Word],
    page_width: float,
    page_height: float,
    raster_width: int,
    raster_height: int,
) -> tuple[TextElement, ...]:
    """Rebuild per-line text with geometry scaled back to PDF points."""
    grouped: dict[tuple[int, int, int, int], list[_Word]] = {}
    for word in words:
        grouped.setdefault(word.line_key, []).append(word)

    x_scale = page_width / raster_width
    y_scale = page_height / raster_height
    elements: list[TextElement] = []
    for line_index, line_words in enumerate(grouped.values(), start=1):
        ordered = sorted(line_words, key=lambda word: word.left)
        left = min(word.left for word in ordered)
        top = min(word.top for word in ordered)
        right = max(word.right for word in ordered)
        bottom = max(word.bottom for word in ordered)
        pieces: list[str] = []
        for position, word in enumerate(ordered):
            if position > 0 and _joins_without_space(ordered[position - 1], word):
                pieces[-1] += word.text
            else:
                pieces.append(word.text)
        elements.append(
            TextElement(
                element_id=f"ocr:text:{line_index}",
                text=" ".join(pieces),
                x=round(left * x_scale, 4),
                y=round(top * y_scale, 4),
                width=round((right - left) * x_scale, 4),
                height=round((bottom - top) * y_scale, 4),
            )
        )
    return tuple(elements)
