# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-11-04
- Primary product surfaces: native Electron conversion window, overview, files, settings, detail and backup dialog
- Evidence reviewed: `hwp2x-2-App.dc.html`, `app.html`, `support.js`

## Brand
- Personality: quiet, precise, trustworthy desktop utility
- Trust signals: real progress, explicit source paths, inline errors, conservative original-file handling
- Avoid: fake datasets, fake telemetry, simulated timestamps, unsupported preservation claims

## Product goals
- Goals: retain the original asset's layout and palette while exposing live conversion state and safe controls
- Non-goals: claim full lossless layout preservation or enable deletion without an explicit engine certification
- Success signals: every visible supported control invokes the real IPC contract and every state is understandable

## 상태 계약과 프로필 호환
- `electron/src/contracts/state.ts`의 계약 버전은 1이다. 기존 상태 응답을 제거하지 않고 `contract`에 버전·진행률·미처리 수·이어하기 가능 여부를 추가한다.
- 진행률은 성공률이 아니다. 완료·실패·건너뜀을 처리 완료로 세고 대기·변환 중은 제외한다. 미처리는 대기·실패·건너뜀을 구분한다.
- 이어하기는 paused 상태에서 대기 파일이 있을 때만 가능하다. 원본 복구 가능 여부는 별도 `cleanup-state.canRollback`이 권위 있는 값이며 변환 상태로 추측하지 않는다.
- 기존 `conversion-state.json` version 1과 버전 없는 수동 한컴 설정은 그대로 읽는다. 이번 변경은 저장 형식을 바꾸거나 기존 프로필을 다시 쓰지 않는다. 설정 계약 버전 1은 기존 형식을 뜻한다.
- IPC 오류는 기존 Promise 거부와 오류 문구를 유지한다. 미구현 오류 코드나 복구 기능을 화면에 노출하지 않는다.
- 공통 GUI 증거는 격리 프로필, 원본 전후 해시, 실제 클릭, 스크린샷, 콘솔 오류, 종료 결과를 남긴다. 배포 실행 경로 누락·개발 실행본은 실패다. 대역 호출은 실제 GUI 합격 근거가 아니다.

## Information architecture
- Primary navigation: 특정 폴더 변환, 전체 자동 변환, 파일, 설정
- Core routes/screens: idle/empty, scanning/converting/paused, done, files/detail, settings, backup consent dialog
- Content hierarchy: phase and message, counts and progress, file rows, selected-file checks, settings

## Design principles
- Original asset overrides any suggested palette, spacing, typography, or component redesign
- Show evidence from the engine; never invent numbers or capabilities
- Keep originals when comparison does not certify eligibility

## Visual language
- Color: use the original `hwp2x-2-App.dc.html` palette and inline styles
- Typography: use the original font declarations and local runtime assets
- Spacing/layout rhythm: preserve original layout; native Electron supplies window chrome
- Shape/radius/elevation: preserve original asset except removed outer framing
- Motion: no simulated progress or decorative animation
- Imagery/iconography: preserve original document illustrations and labels

## Components
- Existing components to reuse: original sidebar, overview, file table, detail panel, settings rows, dialog
- New/changed components: live IPC mapping in `live.js`, inline error region, conservative backup state
- Variants and states: idle, scanning, converting, paused, done, empty, filtered, selected, error, disabled
- Token/component ownership: original asset remains the source of truth

## Accessibility
- Target standard: keyboard-operable native window controls where runtime supports them
- Keyboard/focus behavior: retain native buttons, inputs, links and disabled states
- Contrast/readability: preserve original high-contrast labels and status colors with text labels
- Screen-reader semantics: inline errors use `role=alert`, the last action result uses `role=status`; controls retain button/input semantics. Clickable rows, menu items and filters are `role=button` with Tab focus and Enter/Space; the worker count is a radio group; filters expose `aria-pressed`
- Dialogs (backup, log): `role=dialog aria-modal`, focus moves to the first enabled button when opened, Esc closes
- Reduced motion and sensory considerations: no fake or unnecessary motion

## Responsive behavior
- Supported breakpoints/devices: native Electron minimum window from `main.ts`
- Layout adaptations: original flex/grid layout fills native window without outer 40px frame or fixed 1240x800 shell
- Touch/hover differences: preserve original hover affordances

## Interaction states
- Loading: live scanning/converting phase and current counts
- Empty: run screen shows the chosen folder with a 폴더 선택 button next to the start button
- Running (scanning/converting): start and folder controls are hidden or locked; progress bar, counts and the files being converted stay visible; only 일시정지 and 중지 act
- Paused: 이어하기 continues the same list; 중지 ends it; a new folder or scan is refused until one of those
- Stopped/done: 다른 폴더 선택 opens the folder dialog at once and shows that folder ready on the run screen; 이 폴더 다시 변환 rescans and converts in one press (existing outputs are skipped, never overwritten). Reopening the app after a finished or stopped run starts on the run screen, not the old result
- Error: inline actionable error message; caught IPC promises
- Success: done phase, actual counts, report and backup-folder controls
- Disabled: unsupported backup/deletion remains disabled without certification
- Offline/slow network, if applicable: local IPC errors remain inline; local vendor React avoids CDN runtime dependency

## Content voice
- Tone: concise Korean desktop utility copy
- Terminology: a successful file is `변환됨`, never `일치`, because Hancom results are not compared. The detail panel says which check ran (한컴: 내용 비교 생략; kordoc: 글자·그림 비교) under `확인 항목`; never call it full lossless preservation
- Microcopy rules: state when originals remain and why unsupported actions are disabled

## Implementation constraints
- Framework/styling system: original Design Component runtime with `support.js`, local React UMD, inline template styles
- Design-token constraints: do not replace the original asset palette
- Performance constraints: fetch and render at most 100 file rows per page; full detail is fetched only for the selected file. Automatic conversion keeps bounded batches and watchers, never an unbounded renderer list.
- Compatibility constraints: renderer calls only `window.hwp2x` contract methods
- Test/screenshot expectations: parent runs Electron visual smoke; worker runs syntax/hash/remnant checks

## Open questions
- [ ] Engine certification schema for safe backup/delete eligibility / owner: engine / impact: backup remains disabled until explicit certification
