# Autorità Samsung per i certificati delle TV

I due certificati delle autorità che firmano i certificati Samsung delle TV. Samsung
risponde alla richiesta con il solo certificato finale: la firma dell'app deve portare
anche chi l'ha emesso (vedi `tizen/certificato_samsung.py`).

| File | Chi è | Scade | SHA-256 |
|---|---|---|---|
| `vd_tizen_dev_author_ca.cer` | Samsung VD Author CA (autore) | 2040-06-19 | `50:79:19:6A:1C:32:87:2A:8B:CE:74:52:3F:C1:2A:D3:55:7E:2D:87:C5:6F:AF:BA:7C:6D:09:DC:ED:13:B7:10` |
| `vd_tizen_dev_public2.crt` | VD DEVELOPER Public CA Class (distributore, livello Public) | 2029-06-16 | `BF:18:85:9E:B0:24:CC:1D:63:F0:08:DC:DD:D6:43:07:7B:0D:E5:3E:95:8F:35:99:3F:F0:08:8D:1A:1D:31:AE` |

Presi da [Samsung/tizen-agent-skills](https://github.com/Samsung/tizen-agent-skills)
(`tizen-sdk-skills/common/assets/samsung-tv-ca`, commit `e0df053`), licenza Apache-2.0,
© Samsung Electronics. Sono gli stessi file che installa Tizen Studio. Lo script controlla
le impronte prima di usarli.
