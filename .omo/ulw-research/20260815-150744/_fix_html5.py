# -*- coding: utf-8 -*-
"""Apply remaining 3rd-round proofread fixes to report.html (verbatim current text)."""
import re
from pathlib import Path

p = Path(r"C:\Users\steve\Desktop\projects\impromptu-r2\.omo\ulw-research\20260815-150744\report.html")
s = p.read_text(encoding="utf-8")

REPLS = [
    ("ActiveX, 외부 관계, 암호화 멤버 포함 파일은",
     "ActiveX, 외부 관계, 암호화된 멤버가 포함된 파일은"),
    ("<tr><td>Canva</td><td>편집 가능 변환, 스캔은 플랫 이미지",
     "<tr><td>Canva</td><td>편집 가능한 형식으로 변환. 스캔 자료는 단일 이미지로 가져옴"),
    ("가장 넓은 진입점·구체적 한도 문서화", "가져오기 경로가 가장 다양하고 한도 문서화가 구체적"),
    # four-mode paragraph: append after the note paragraph in section 6
    ("참고로 \"동시 사용자 약 10명\"은 <code>DEMO-SCOPE.md</code>에 명시된 수치가 아니라 계획상 가정입니다(C42/C64).</p>",
     "참고로 \"동시 사용자 약 10명\"은 <code>DEMO-SCOPE.md</code>에 명시된 수치가 아니라 계획상 가정입니다(C42/C64).</p>\n  <p><b>경쟁사 아키텍처는 4가지 모드로 수렴합니다 (C73):</b> ① 편집 가능한 객체 변환(Pitch, Canva, Beautiful.ai, Google Slides) ② 정적 래스터 가져오기(Mentimeter, Prezi 클래식, Sendsteps) ③ URL 임베드(Mentimeter) ④ 메타데이터만 담은 자리표시자 슬라이드(Poll Everywhere, Slido). 어느 벤더도 Office 파일 업로드에 적용하는 악성 코드 검사 정책을 공개하지 않았으며(C72), 업로드 신뢰 경계를 명확히 공개해 차별화할 수 있는 지점입니다.</p>"),
    ("계약이 요구하는 실제 안정적 Stage에서 가져올 수 있는 실제 URL(오브젝트 스토어/CDN 또는 인증된 프로젝션 자산 라우트)",
     "Stage가 실제로 가져올 수 있고 계약 요건을 충족하는 URL(오브젝트 스토어/CDN 또는 인증된 프로젝션 자산 라우트)"),
    ("버전을 deckVersion 식별에 포함되어야 함", "버전을 <code>deckVersion</code> 산정 기준에 포함해야 함"),
    ("Malgun Gothic 지정 데크의 LibreOffice 대체 충실도",
     "Noto CJK에 필요한 글리프가 있어도 Malgun Gothic을 썼을 때와 같은 레이아웃 충실도가 보장되지는 않음 (C63)"),
]

# regex for the C24 parenthetical (dash char unknown in file)
s2 = re.sub(r"\(C24[^)]*\)", "(C24, 구현할 때 측정해야 하며 현재 저장소에는 PPTX 픽스처가 없음)", s)

missing = []
for old, new in REPLS:
    if old in s2:
        s2 = s2.replace(old, new)
    else:
        missing.append(old[:70])

p.write_text(s2, encoding="utf-8", newline="\n")
print(f"applied {len(REPLS) + 1 - len(missing)}/{len(REPLS) + 1} replacements (incl. regex)")
for m in missing:
    print("MISSING:", m.replace("\n", "\\n"))
