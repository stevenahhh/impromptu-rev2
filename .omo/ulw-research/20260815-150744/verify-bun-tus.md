# Verify: tus Bun 호환 스모크테스트

**Claim**: C6 — `tus-node-server` v2의 Bun 지원은 README 주장일 뿐 CI로 증명되지 않음 (HIGH RISK, lane-resumable-upload 보고)

**Verification path**: 직접 실행 (lead, Bash)

**Environment**: Windows 11 (win32 x64), Bun 1.3.14 (프로젝트와 동일 버전), 임시 디렉토리 `/tmp/tmp.bWXYkPJMpk` (프로젝트 외부, node_modules/package.json 오염 없음)

**Commands**:
```
bun add @tus/server @tus/file-store   # 성공: @tus/server@2.4.4, @tus/file-store@2.1.1 설치 (71 packages)
bun -e "import * as s from '@tus/server'; import * as f from '@tus/file-store'; ..."
```

**Output (핵심)**:
- `@tus/server` exports: `Server`, `DataStore`, `FileKvStore`, `MemoryLocker`, `TUS_RESUMABLE`, `Upload`, `StreamLimiter`, ... (26개)
- `@tus/file-store` exports: `FileStore`, `FileConfigstore`, `MemoryConfigstore`, `RedisConfigstore`
- 설치 시 170초 소요 (네트워크), 잔여 오류 없음. 타임아웃은 전체 명령 데드라인(120s)으로 인한 세션 분리 — 설치/임포트 자체는 정상 완료.

**Verdict**: **PARTIAL-CONFIRMED** — 패키지 설치·ESM 임포트·클래스 노출까지 Bun 1.3.14에서 정상. 단, 실제 tus 핸드셰이크(POST/PATCH/HEAD) E2E는 실행하지 않았으므로 "전체 런타임 동작"은 미검증 상태 유지. repo-dive 레인의 srvx `"bun"` export condition + `handleWeb(Request)` 표면 분석과 함께 고신뢰로 상향.

**결론**: C6을 "vendor claim"에서 "설치/임포트 검증됨, E2E 미검증"으로 갱신. MVP에서 tus 미채택(C39)이라 실무 리스크 없음.
