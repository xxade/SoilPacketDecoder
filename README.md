# SoilPacketDecoder

Декодер и энкодер пакетов **SoilTransmitter** (Water7 + compact regular `0x99`).

## Использование

**Онлайн:** https://xxade.github.io/SoilPacketDecoder/

Локально откройте в браузере:

- **`index.html`** — однофайловая версия (удобно отправлять в Telegram)
- **`water7-decoder/`** — исходники с раздельными HTML / CSS / JS

Работает офлайн, без зависимостей.

## Поддерживаемые пакеты

| Тип | Описание |
| --- | -------- |
| `0x99` | Regular UL — VDD, датчики почвы (T, VWC, EC) |
| `0x03` / `0x07` / `0x06` / `0x10` | Water7 read / write params |
| `0x20` | События (LOW_BATTERY, MODBUS_TIMEOUT, …) |
| `0x27` | Control-команды (FORCE_WAKEUP, RESET, …) |
| `0x4x` | Ошибки Water7 |

## Спецификация

См. [WATER7_DEVICE_PROFILE.md](https://github.com/xxade/SoilTransmitter/blob/main/WATER7_DEVICE_PROFILE.md) в прошивке SoilTransmitter.
