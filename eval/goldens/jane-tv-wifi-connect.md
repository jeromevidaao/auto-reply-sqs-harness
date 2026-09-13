# Golden: Jane TV WiFi connect (West End Victorian)

**Scenario**: Jane is mid-stay (Sep 12–16 2026) at the West End Victorian. She enjoyed the stay so far but the TV will not connect to wifi and she asks if there are specific steps.

## Rubric
- shouldReply: true
- expectedType: WIFI_TROUBLESHOOTING
- MUST contain TEST_WIFI_SSID, test-wifi-password, "Let me know if it works"
- MUST give brief settings / reconnect steps, not withhold credentials

## Good response
"Hi Jane, please check the WiFi settings on the TV, then connect to the network TEST_WIFI_SSID with password test-wifi-password. Let me know if it works."

## Bad response (the production miss)
No reply. wifi.md said only provide credentials when the guest explicitly asks for the password or network name. Asking for TV connection steps did not qualify.

## Notes
Jane · West End Victorian · 2026-09-12–16. Policy layer `_applyWifiPolicy` is the hard backstop. Use TEST_HOST_CONTACTS / `{{WIFI_SSID}}` `{{WIFI_PASSWORD}}` — do not invent production secrets. Pineland/lobsterbake stays the existing WIFI_PASSWORD golden convention in wifi.md.
