# -*- coding: utf-8 -*-
"""Apply 3rd-round proofread fixes to report.html."""
from pathlib import Path

p = Path(r"C:\Users\steve\Desktop\projects\impromptu-r2\.omo\ulw-research\20260815-150744\report.html")
s = p.read_text(encoding="utf-8")

REPLS = [
    # 1. 발행 row rasterizer wording
    ("래스터라이저는 기존 PyMuPDF(리소스 제한 적용 워커의 <code>get_pixmap()</code>)와 Poppler를 한국어 검증용 코퍼스로 비교해 결정 (C61)",
     "래스터라이저는 한국어 검증용 코퍼스를 사용해 기존 PyMuPDF(리소스 제한 적용 워커의 <code>get_pixmap()</code>)와 Poppler를 비교한 뒤 결정(C61)"),
    # 2. add render-clarification callout after 3.1 table
    ("  </table>\n\n  <h3>3.2 최소 변경 통합 지점 (ingestion-integration FINAL)</h3>",
     "  </table>\n\n  <div class=\"callout\">\n    <b>렌더링 방식의 명확화:</b> 첫 데모에서는 운영자가 변환 도구를 직접 실행하고 결과를 검토하는 수동 게이트를 둡니다. 상시 실행되는 자동 오케스트레이션(작업 재시도, 아티팩트 승격, 공개 저장 자동화)은 도입하지 않습니다. 자동화는 운영자 처리량을 측정해 수동 게이트가 병목으로 확인된 이후에 검토합니다 (skeptic D2).\n  </div>\n\n  <h3>3.2 최소 변경 통합 지점 (ingestion-integration FINAL)</h3>"),
    # 3. mapping item
    ("<code>extractedText</code>는 구조 요소를 결정론적으로 평탄화",
     "<code>extractedText</code>에는 구조 요소를 결정론적으로 평탄화한 값을 저장"),
    # 4. security table: encrypted members
    ("ActiveX, 외부 관계, 암호화 멤버가 포함된 파일은 파싱 전 거부(D4)",
     "ActiveX, 외부 관계, 암호화된 멤버가 포함된 파일은 파싱 전 거부(D4)"),
    # 5. PyMuPDF row
    ("CVE-2026-3308(RCE, 1.27.0 이하)이 현재 선언된 의존성 범위",
     "CVE-2026-3308의 영향을 받는 1.27.0 이하 버전(RCE)이 현재 선언된 의존성 범위"),
    # 6. UX flow steps
    ("    <span class=\"step\">Verifying</span><span class=\"arrow\">→</span>\n    <span class=\"step\">Converting</span><span class=\"arrow\">→</span>\n    <span class=\"step\">Ready</span>",
     "    <span class=\"step\">Verifying</span><span class=\"arrow\">→</span>\n    <span class=\"step\">Awaiting Operator Render</span><span class=\"arrow\">→</span>\n    <span class=\"step\">Converting</span><span class=\"arrow\">→</span>\n    <span class=\"step\">READY_PREVIEW</span>"),
    # 7. approval gate item
    ("<li>변환 완료 후 <b>발표자 프리뷰/승인 게이트</b>(READY_PREVIEW → 승인 → 발행) — 폰트 대체·레이아웃 드리프트를 세션 시작 전에 확인하는 안전 게이트 (C63)</li>",
     "<li>변환 완료 후 운영자와 발표자가 비공개 미리보기를 검토하되, 승인과 공개 아티팩트로의 수동 승격은 운영자만 수행(<code>READY_PREVIEW</code> → 운영자 승인 → 공개 아티팩트 승격). 폰트 대체·레이아웃 변화를 세션 시작 전에 확인하는 안전 게이트 (C63)</li>"),
    # 8. Canva row
    ("편집 가능한 형식으로 변환. 스캔 자료는 플랫 이미지", "편집 가능한 형식으로 변환. 스캔 자료는 단일 이미지로 가져옴"),
    ("진입점이 가장 많고 한도 문서화가 구체적", "가져오기 경로가 가장 다양하고 한도 문서화가 구체적"),
    # 9. note sentence
    ("(참고: \"동시 사용자 약 10명\"은 <code>DEMO-SCOPE.md</code>에 명시된 수치가 아니라 계획상 가정입니다. C42/C64.)",
     "참고로 \"동시 사용자 약 10명\"은 <code>DEMO-SCOPE.md</code>에 명시된 수치가 아니라 계획상 가정입니다(C42/C64)."),
    # 10. four-mode sentence
    ("④ 메타데이터 홀딩 슬라이드(Poll Everywhere, Slido). 어느 벤더도 오피스 업로드 전용 악성코드 검사 계약을 공개하지 않았으며(C72), 이는 우리가 명확한 업로드 신뢰 경계 성명으로 차별화할 수 있는 지점입니다.",
     "④ 메타데이터만 담은 자리표시자 슬라이드(Poll Everywhere, Slido). 어느 벤더도 Office 파일 업로드에 적용하는 악성 코드 검사 정책을 공개하지 않았으며(C72), 업로드 신뢰 경계를 명확히 공개해 차별화할 수 있는 지점입니다."),
    # 11. Gotenberg item
    ("(C24. 구현 시 측정 필요. 현재 저장소에 PPTX 픽스처 없음)",
     "(C24, 구현할 때 측정해야 하며 현재 저장소에는 PPTX 픽스처가 없음)"),
    # 12. public image / version
    ("계약이 요구하는 Stage에서 가져올 수 있는 실제 URL(오브젝트 스토어/CDN 또는 인증된 프로젝션 자산 라우트)",
     "Stage가 실제로 가져올 수 있고 계약 요건을 충족하는 URL(오브젝트 스토어/CDN 또는 인증된 프로젝션 자산 라우트)"),
    ("버전을 <code>deckVersion</code> 식별에 포함", "버전을 <code>deckVersion</code> 산정 기준에 포함"),
    # 13. font item
    ("Noto CJK에 필요한 글리프가 있어도 Malgun Gothic과 같은 레이아웃 충실도가 보장되지는 않음",
     "Noto CJK에 필요한 글리프가 있어도 Malgun Gothic을 썼을 때와 같은 레이아웃 충실도가 보장되지는 않음"),
]

missing = []
for old, new in REPLS:
    if old in s:
        s = s.replace(old, new)
    else:
        missing.append(old[:70])

p.write_text(s, encoding="utf-8", newline="\n")
print(f"applied {len(REPLS) - len(missing)}/{len(REPLS)} replacements")
for m in missing:
    print("MISSING:", m.replace("\n", "\\n"))
