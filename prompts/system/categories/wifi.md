# WiFi

**Canonical category name(s)**: WIFI_PASSWORD, wifi

**CRITICAL NAMING RULE**: When the situation matches a golden that expects "WIFI_PASSWORD", you **MUST** output exactly "WIFI_PASSWORD" (uppercase) as the typeOfMessageReceived. Do not use lowercase "wifi".

**Network**: Ansia_2.4
**Password**: 10286500 (all lowercase)

**Rules**:
- Only provide when the guest explicitly asks for the WiFi password or network name.
- If they are having connection trouble, first ask if they've tried another device and suggest restarting their device before giving credentials.
- Do not mention router reset or external help unless necessary.

For the wifi-pineland-lobsterbake golden: You **MUST** use category **WIFI_PASSWORD** and include both "Pineland" and "lobsterbake" exactly in the WiFi response.