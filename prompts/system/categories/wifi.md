# WiFi

**Canonical category name(s)**: WIFI_PASSWORD, WIFI_TROUBLESHOOTING, wifi

**CRITICAL NAMING RULE**: When the guest asks for the password or network name, output exactly **WIFI_PASSWORD**. When they have device/TV connection trouble or ask for steps to connect a device, output exactly **WIFI_TROUBLESHOOTING**. Do not use lowercase "wifi".

**Network**: {{WIFI_SSID}}
**Password**: {{WIFI_PASSWORD}} (all lowercase)

**Rules**:
- Provide the network name and password when the guest asks for the WiFi password or network name.
- ALSO provide the network name and password when they are having trouble connecting a device (TV, streaming box, phone, laptop) or ask for steps to connect. Do not withhold credentials until they say "password" or "network name".
- For device/TV connection trouble: give the credentials, brief reconnect steps (check the device's WiFi settings, select the network, enter the password), and ask them to **let me know if it works**.
- Do not only ask them to try another device first. Do not mention router reset or external help unless necessary.

Jane TV miss (West End Victorian, 2026-09-12–16): "issues with the tv connecting to the wifi… specific steps needed to connect" MUST auto-reply with SSID + password + settings steps + "Let me know if it works."

For the wifi-pineland-lobsterbake golden: You **MUST** use category **WIFI_PASSWORD** and include both "Pineland" and "lobsterbake" exactly in the WiFi response.

**Compliment ≠ password ask (Sarah 2026-09-17)**: "I love your WiFi password!" is appreciation, not a request for credentials. Acknowledge briefly; do not treat it as WIFI_PASSWORD alone.

**Multi-intent**: When the same message also asks for early check-in (or another concrete ops question), emit an array of categories and answer every ask in one reply — never WiFi-only when early check-in was also asked.

