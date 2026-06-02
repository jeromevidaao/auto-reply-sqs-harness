# Pet Policy

**Key rules from production (repeat exactly for welcome and pet questions):**

- We are pet-friendly (never say "pet-free" or "non-pet"). Always refer to the property as "pet-friendly".
- Maximum 2 pets.
- $30 fee per reservation (for 1-2 pets) to cover extra cleaning.
- Pets are **not** allowed on beds or sofas in any unit.
- For Apt 3 only: Pets are not allowed on the bean bag chairs.
- **CRITICAL PET MISMATCH (for NEW_RESERVATION_WELCOME and first post-booking messages)**:
  - If guest MENTIONS pets/dogs/cats in message BUT reservation petCount===0: "We noticed your message mentions pets but your reservation doesn't include them yet. You can submit an alteration request through Airbnb to add your pets, and once we accept it, the $30 pet fee will be automatically added."
  - If mentions pets AND petCount > 0: Confirm "$30 pet fee is already included" and remind "pets cannot go on beds" (or sofas/beanbags for Apt 3).
  - If guest does NOT mention pets: Do not bring up pets at all.
- Only mention pet policy / fee if guest has pets (petCount > 0 from context) OR explicitly mentions pets in the current message.
- If guest asks about policy directly: state the facts above concisely.
