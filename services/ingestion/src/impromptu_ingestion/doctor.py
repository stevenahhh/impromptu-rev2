"""Runtime diagnostics that do not inspect or expose provider credentials."""

import sys
from importlib.metadata import PackageNotFoundError, version

from impromptu_ingestion.contracts import (
    DoctorReport,
    InputKind,
    PythonDoctorStatus,
    RenderingDoctorStatus,
)

_REQUIRED_DISTRIBUTIONS = ("pydantic", "pymupdf", "python-pptx")


def _dependency_versions() -> tuple[dict[str, str], bool]:
    versions: dict[str, str] = {}
    available = True
    for distribution in _REQUIRED_DISTRIBUTIONS:
        try:
            versions[distribution] = version(distribution)
        except PackageNotFoundError:
            versions[distribution] = "missing"
            available = False
    return versions, available


def doctor_report() -> DoctorReport:
    """Return machine-readable core extraction health and explicit exclusions."""
    dependencies, dependencies_available = _dependency_versions()
    python_supported = sys.version_info[:2] == (3, 14)
    return DoctorReport(
        ok=python_supported and dependencies_available,
        python=PythonDoctorStatus(
            current=".".join(str(part) for part in sys.version_info[:3]),
            supported=python_supported,
        ),
        dependencies=dependencies,
        structural_extractors={
            InputKind.PDF: dependencies["pymupdf"] != "missing",
            InputKind.PPTX: dependencies["python-pptx"] != "missing",
        },
        rendering=RenderingDoctorStatus(),
    )
