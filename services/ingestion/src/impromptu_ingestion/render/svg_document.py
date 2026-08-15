"""Small typed XML boundary shared by SVG rendering components."""

from collections.abc import Callable
from xml.etree import ElementTree as ET

ErrorFactory = Callable[[str, str], RuntimeError]


def parse_untrusted_xml(
    source: str | bytes,
    error_factory: ErrorFactory,
    code: str,
    subject: str,
) -> ET.Element:
    """Parse bounded-by-caller XML while rejecting entity declarations."""
    match source:
        case str():
            unsafe = "<!ENTITY" in source.upper()
        case bytes():
            unsafe = b"<!ENTITY" in source.upper()
    if unsafe:
        raise error_factory(code, f"{subject} declarations are not allowed")
    try:
        return ET.fromstring(source)
    except (ET.ParseError, ValueError) as error:
        raise error_factory(code, f"{subject} is not well-formed: {error}") from error
