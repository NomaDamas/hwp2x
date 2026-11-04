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

## Information architecture
- Primary navigation: 개요, 파일, 설정
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
- Screen-reader semantics: inline errors use `role=alert`; controls retain button/input semantics
- Reduced motion and sensory considerations: no fake or unnecessary motion

## Responsive behavior
- Supported breakpoints/devices: native Electron minimum window from `main.ts`
- Layout adaptations: original flex/grid layout fills native window without outer 40px frame or fixed 1240x800 shell
- Touch/hover differences: preserve original hover affordances

## Interaction states
- Loading: live scanning/converting phase and current counts
- Empty: folder selection prompt and empty files message
- Error: inline actionable error message; caught IPC promises
- Success: done phase, actual counts, report and backup-folder controls
- Disabled: unsupported backup/deletion remains disabled without certification
- Offline/slow network, if applicable: local IPC errors remain inline; local vendor React avoids CDN runtime dependency

## Content voice
- Tone: concise Korean desktop utility copy
- Terminology: say `텍스트·블록 비교`; do not call it full lossless preservation
- Microcopy rules: state when originals remain and why unsupported actions are disabled

## Implementation constraints
- Framework/styling system: original Design Component runtime with `support.js`, local React UMD, inline template styles
- Design-token constraints: do not replace the original asset palette
- Performance constraints: render all filtered files without a 40-row cap; poll live state only
- Compatibility constraints: renderer calls only `window.hwp2x` contract methods
- Test/screenshot expectations: parent runs Electron visual smoke; worker runs syntax/hash/remnant checks

## Open questions
- [ ] Engine certification schema for safe backup/delete eligibility / owner: engine / impact: backup remains disabled until explicit certification
