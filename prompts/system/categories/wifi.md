# WiFi

**Canonical category name(s)**: WIFI_PASSWORD, WIFI_TROUBLESHOOTING, wifi

**CRITICAL NAMING RULE**: When the guest asks for the password or network name, output exactly **WIFI_PASSWORD**. When they have device/TV connection trouble or ask for steps to connect a device, output exactly **WIFI_TROUBLESHOOTING**. Do not use lowercase "wifi".

**Network (property-aware)**:
- Pine St / West End Victorian (Apt 1B, Apt 2, Apt 3): **Pineland** / **lobsterbake** (from check-in templates — never the global hostContacts `{{WIFI_SSID}}` / `{{WIFI_PASSWORD}}` if those still hold Ansia_2.4 / 10286500).
- Other / unknown: {{WIFI_SSID}} / {{WIFI_PASSWORD}} from host contacts.
**Password**: {{WIFI_PASSWORD}} (all lowercase)

**Rules**:
- Provide the network name and password when the guest asks for the WiFi password or network name.
- ALSO provide the network name and password when they are having trouble connecting a device (TV, streaming box, phone, laptop) or ask for steps to connect. Do not withhold credentials until they say "password" or "network name".
- For device/TV connection trouble: give the credentials, brief reconnect steps (check the device's WiFi settings, select the network, enter the password), and ask them to **let me know if it works**.
- Do not only ask them to try another device first. Do not mention router reset or external help unless necessary.

Jane TV miss (West End Victorian, 2026-09-12–16): "issues with the tv connecting to the wifi… specific steps needed to connect" MUST auto-reply with SSID + password + settings steps + "Let me know if it works."

For the wifi-pineland-lobsterbake golden: You **MUST** use category **WIFI_PASSWORD** and include both "Pineland" and "lobsterbake" exactly in the WiFi response.

**Compliment ≠ password ask (Sarah 2026-09-17)**: "I love your WiFi password!" is appreciation, not a request for credentials. Warm ack only — **never** dump SSID/password on a compliment.

**Multi-intent with early check-in (CRITICAL)**: When the same message compliments WiFi **and** asks for early check-in, the actionable category is **EARLY_CHECKIN** (classic cleaning-finishes / message-you reply). Do **not** inject WiFi credentials. Do **not** answer WiFi-only and drop early check-in.

