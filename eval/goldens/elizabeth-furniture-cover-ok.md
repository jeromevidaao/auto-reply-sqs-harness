# elizabeth-furniture-cover-ok

## Rubric
- shouldReply: true
- expectedType: PET_QUESTIONS
- MUST say covering the furniture is **fine with us**
- MUST say **No need to cancel**
- MUST mention **cover the furniture**
- **MUST NOT** link Airbnb help/article/475
- **MUST NOT** say the pet rule is firm / dogs can't go on the beds / strict cancellation

## Good response examples
"This is fine with us if you cover the furniture. No need to cancel — thanks for checking with us!"

"Hi Elizabeth, this is fine with us if you cover the furniture. No need to cancel — thanks for checking with us!"

## Bad response (the production bug)
"Good evening Elizabeth, thank you — we appreciate you covering the furniture. The pet rule is firm though, so dogs can't go on the beds. If that won't work for your stay, please review our strict cancellation policy here: https://www.airbnb.com/help/article/475."

## Notes
Elizabeth Apt 3 2026-08-27 (reservation fe01d62b). Guest travels with extra sheets and always covers the furniture; dogs jump on beds at home; offered to cancel. Host already replied live — do not re-send. Policy: `_applyPetFurnitureMitigationPolicy`.
