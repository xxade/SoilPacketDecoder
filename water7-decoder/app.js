'use strict';

const PARAMS = {
    0:   { name: 'Humidity', unit: '%', rw: 'RW' },
    1:   { name: 'Conductivity', unit: 'µS/cm', rw: 'RW' },
    2:   { name: 'Temperature', unit: '0.01 °C', rw: 'RW', decode: v => (v / 100).toFixed(2) + ' °C' },
    3:   { name: 'Battery', unit: 'mV', rw: 'RO' },
    10:  { name: 'WakePeriod', unit: 'сек', rw: 'RW' },
    100: { name: 'ProtocolVersion', unit: '—', rw: 'RO' },
    101: { name: 'SensorType', unit: 'enum', rw: 'RO', decode: decodeSensorType },
    102: { name: 'BoardRevision', unit: '—', rw: 'RO' },
    103: { name: 'FirmwareVersion', unit: 'packed', rw: 'RO', decode: decodeFirmwareVersion },
    104: { name: 'ManufactureDate', unit: 'uint16', rw: 'RO' },
};

const COMMANDS = {
    1: 'FORCE_WAKEUP',
    2: 'RESET_DEVICE',
    3: 'FACTORY_RESET',
    4: 'SEND_STATUS_NOW',
};

const EVENTS = {
    1: { name: 'LOW_BATTERY', decode: p => `VDD = ${p} mV` },
    2: { name: 'SENSOR_ERROR', decode: () => 'все датчики offline' },
    3: { name: 'MODBUS_TIMEOUT', decode: p => `Modbus ID = ${p}` },
    4: { name: 'FLASH_ERROR', decode: () => 'ошибка flash' },
    5: { name: 'SETTINGS_CHANGED', decode: () => 'WakePeriod записан' },
    6: { name: 'DEVICE_RESET', decode: () => 'сброс / init' },
};

const ERROR_CODES = {
    0x01: 'INVALID_TYPE',
    0x02: 'INVALID_ADDRESS',
    0x03: 'INVALID_VALUE',
    0x04: 'LL_ERROR',
    0x05: 'READ_ONLY',
    0x06: 'INVALID_LENGTH',
};

const PACKET_TYPES = {
    0x03: 'Read multiple',
    0x06: 'Write single',
    0x07: 'Read single',
    0x10: 'Write multiple',
    0x20: 'Event',
    0x27: 'Control',
    0x29: 'FW update',
    0x99: 'Regular UL (SoilTransmitter)',
};

const WRITE_HINTS = {
    0: '0…100 %',
    1: '0…65535 µS/cm',
    2: '−5000…20500 (сотые °C)',
    10: '60…604800 сек',
};

function decodeSensorType(v) {
    const map = { 0: 'unknown', 1: 'SOIL_RS485' };
    return `${v} (${map[v] ?? '?'})`;
}

function decodeFirmwareVersion(v) {
    const year = (v >> 10) & 0x3FFF;
    const month = (v >> 6) & 0x0F;
    const day = v & 0x3F;
    return `${year}.${month}.${day} (raw 0x${(v >>> 0).toString(16).toUpperCase()})`;
}

function parseHex(str) {
    const cleaned = str.replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '');
    if (!cleaned.length) return [];
    if (cleaned.length % 2 !== 0) throw new Error('Нечётное число hex-символов');
    const bytes = [];
    for (let i = 0; i < cleaned.length; i += 2) {
        bytes.push(parseInt(cleaned.slice(i, i + 2), 16));
    }
    return bytes;
}

function toHex(bytes, sep = ' ') {
    return bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(sep);
}

function readBE16(bytes, off) {
    return (bytes[off] << 8) | bytes[off + 1];
}

function readBE32(bytes, off) {
    return ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >> 0;
}

function readLE16(bytes, off) {
    return (bytes[off + 1] << 8) | bytes[off];
}

function writeBE16(val) {
    return [(val >> 8) & 0xFF, val & 0xFF];
}

function writeBE32(val) {
    val = val >> 0;
    return [(val >> 24) & 0xFF, (val >> 16) & 0xFF, (val >> 8) & 0xFF, val & 0xFF];
}

function formatParam(addr, raw) {
    const p = PARAMS[addr];
    if (!p) return `param ${addr}: ${raw}`;
    const decoded = p.decode ? p.decode(raw) : `${raw} ${p.unit}`;
    return `${p.name} [${addr}] = ${decoded}`;
}

function decodeVddWire(wire) {
    const mv = 2500 + wire * 5;
    return `${mv} mV (wire=${wire})`;
}

function decodeSensorBlock(bytes, idx) {
    const off = idx * 4;
    const tRaw = readLE16(bytes, off);
    const vwc = bytes[off + 2];
    const ec = bytes[off + 3];
    const allZero = tRaw === 0 && vwc === 0 && ec === 0;

    if (allZero) {
        return `  #${idx}: offline (нули)`;
    }
    const temp = (tRaw * 0.1).toFixed(1);
    const moisture = (vwc * 0.5).toFixed(1);
    const cond = ec * 40;
    return `  #${idx}: T=${temp} °C, VWC=${moisture} %, EC=${cond} µS/cm  [${toHex(bytes.slice(off, off + 4), '')}]`;
}

function decodeRegular99(bytes) {
    const lines = [];
    lines.push('Тип: Regular UL 0x99 (SoilTransmitter)');
    lines.push(`Длина: ${bytes.length} байт`);

    if (bytes.length < 2) {
        lines.push('Ошибка: слишком короткий пакет (мин. 2 байта)');
        return lines.join('\n');
    }

    const wire = bytes[1];
    lines.push(`VDD: ${decodeVddWire(wire)}`);

    const dataLen = bytes.length - 2;
    if (dataLen % 4 !== 0) {
        lines.push(`Предупреждение: хвост ${dataLen} байт — не кратен 4`);
    }

    const count = Math.floor(dataLen / 4);
    lines.push(`Датчиков: ${count}`);
    for (let i = 0; i < count; i++) {
        lines.push(decodeSensorBlock(bytes.slice(2), i));
    }
    return lines.join('\n');
}

function decodeError(bytes) {
    const baseType = bytes[0] & 0xBF;
    const typeName = PACKET_TYPES[baseType] ?? `0x${baseType.toString(16).toUpperCase()}`;
    const code = bytes[1];
    const codeName = ERROR_CODES[code] ?? `0x${code.toString(16).toUpperCase()}`;
    return [
        `Тип: Ошибка Water7`,
        `Исходный тип: 0x${baseType.toString(16).toUpperCase().padStart(2, '0')} (${typeName})`,
        `Код: 0x${code.toString(16).toUpperCase().padStart(2, '0')} — ${codeName}`,
        `Hex: ${toHex(bytes)}`,
    ].join('\n');
}

function decodeReadMultiple(bytes) {
    const lines = [];
    const addr = readBE16(bytes, 1);
    const count = readBE16(bytes, 3);
    lines.push('Тип: Read multiple 0x03');
    lines.push(`Адрес: ${addr}, кол-во: ${count}`);
    lines.push(`Длина: ${bytes.length} байт (ожид. ${5 + count * 4})`);

    if (bytes.length >= 5 + count * 4) {
        lines.push('Значения:');
        for (let i = 0; i < count; i++) {
            const off = 5 + i * 4;
            const val = readBE32(bytes, off);
            lines.push(`  ${formatParam(addr + i, val)}`);
        }
    }
    lines.push(`Hex: ${toHex(bytes)}`);
    return lines.join('\n');
}

function decodeReadSingle(bytes) {
    const isRequest = bytes.length === 3;
    const addr = readBE16(bytes, 1);
    const lines = [];
    lines.push(`Тип: Read single 0x07 (${isRequest ? 'запрос DL' : 'ответ UL'})`);
    lines.push(`Адрес: ${addr}`);

    if (!isRequest && bytes.length >= 7) {
        const val = readBE32(bytes, 3);
        lines.push(formatParam(addr, val));
    }
    lines.push(`Hex: ${toHex(bytes)}`);
    return lines.join('\n');
}

function decodeWriteSingle(bytes) {
    const addr = readBE16(bytes, 1);
    const val = readBE32(bytes, 3);
    const lines = [];
    lines.push('Тип: Write single 0x06');
    lines.push(`Адрес: ${addr}`);
    lines.push(formatParam(addr, val));
    lines.push(`Hex: ${toHex(bytes)}`);
    return lines.join('\n');
}

function decodeWriteMultiple(bytes) {
    const addr = readBE16(bytes, 1);
    const count = readBE16(bytes, 3);
    const isRequest = bytes.length === 5 + count * 4;
    const lines = [];
    lines.push(`Тип: Write multiple 0x10 (${isRequest ? 'запрос DL' : 'ответ UL (header)'})`);
    lines.push(`Адрес: ${addr}, кол-во: ${count}`);

    if (isRequest) {
        lines.push('Значения:');
        for (let i = 0; i < count; i++) {
            const off = 5 + i * 4;
            const val = readBE32(bytes, off);
            lines.push(`  ${formatParam(addr + i, val)}`);
        }
    }
    lines.push(`Hex: ${toHex(bytes)}`);
    return lines.join('\n');
}

function decodeEvent(bytes) {
    const id = readBE16(bytes, 1);
    const payload = readBE16(bytes, 3);
    const ev = EVENTS[id];
    const lines = [];
    lines.push('Тип: Event 0x20 (UL)');
    if (ev) {
        lines.push(`Событие: ${id} — ${ev.name}`);
        lines.push(`Payload: ${ev.decode(payload)}`);
    } else {
        lines.push(`Событие: ${id} (неизвестно)`);
        lines.push(`Payload: ${payload}`);
    }
    lines.push(`Hex: ${toHex(bytes)}`);
    return lines.join('\n');
}

function decodeControl(bytes) {
    const cmd = bytes[1];
    const statusOrZero = bytes[2];
    const payload = readBE32(bytes, 3);

    const lines = [];
    lines.push('Тип: Control 0x27');

    if (statusOrZero === 0) {
        lines.push('Направление: запрос DL или ответ UL (status=0, payload=0)');
    } else {
        lines.push('Направление: ответ UL');
        const errName = ERROR_CODES[statusOrZero];
        lines.push(`Status: ${statusOrZero}${errName ? ` — ${errName}` : ''}`);
    }

    const cmdName = COMMANDS[cmd] ?? `неизвестная (${cmd})`;
    lines.push(`Команда: ${cmd} — ${cmdName}`);
    if (payload !== 0) {
        lines.push(`Payload: ${payload}`);
    }
    lines.push(`Hex: ${toHex(bytes)}`);
    return lines.join('\n');
}

function decodePacket(bytes) {
    if (!bytes.length) throw new Error('Пустой ввод');

    const type = bytes[0];

    if (type & 0x40 && type !== 0x40) {
        if (bytes.length >= 2) return decodeError(bytes);
    }

    switch (type) {
    case 0x99: return decodeRegular99(bytes);
    case 0x03: return decodeReadMultiple(bytes);
    case 0x06: return decodeWriteSingle(bytes);
    case 0x07: return decodeReadSingle(bytes);
    case 0x10: return decodeWriteMultiple(bytes);
    case 0x20: return decodeEvent(bytes);
    case 0x27: return decodeControl(bytes);
    case 0x29:
        return [
            'Тип: FW update 0x29',
            'Статус: не реализовано (заглушка → ошибка 0x69 0x01)',
            `Hex: ${toHex(bytes)}`,
        ].join('\n');
    default:
        return [
            `Неизвестный тип: 0x${type.toString(16).toUpperCase().padStart(2, '0')}`,
            `Длина: ${bytes.length} байт`,
            `Hex: ${toHex(bytes)}`,
        ].join('\n');
    }
}

function encodeControl(cmd, payload) {
    const p = parseInt(payload, 10) || 0;
    return [0x27, cmd, 0x00, ...writeBE32(p)];
}

function encodeReadSingle(addr) {
    return [0x07, ...writeBE16(addr)];
}

function encodeReadMultiple(addr, count) {
    return [0x03, ...writeBE16(addr), ...writeBE16(count)];
}

function encodeWriteSingle(addr, value) {
    const v = parseInt(value, 10);
    if (Number.isNaN(v)) throw new Error('Некорректное значение param');
    return [0x06, ...writeBE16(addr), ...writeBE32(v)];
}

function encodeWriteMultiple(addr, count, values) {
    if (values.length !== count) {
        throw new Error(`Нужно ${count} значений, получено ${values.length}`);
    }
    const packet = [0x10, ...writeBE16(addr), ...writeBE16(count)];
    for (const raw of values) {
        const v = parseInt(raw.trim(), 10);
        if (Number.isNaN(v)) throw new Error(`Некорректное значение: ${raw}`);
        packet.push(...writeBE32(v));
    }
    return packet;
}

function showToast(msg, type) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = `result ${type} show`;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.remove('show'), 2500);
}

function updateEncodeFields() {
    const type = document.getElementById('encodeType').value;

    const fields = {
        encodeControl: type === '27',
        encodeAddr: type === '07' || type === '03' || type === '06' || type === '10',
        encodeCount: type === '03' || type === '10',
        encodeValue: type === '06',
        encodeMultiValues: type === '10',
        encodePayload: type === '27',
    };

    for (const [id, visible] of Object.entries(fields)) {
        document.getElementById(id).classList.toggle('hidden', !visible);
    }

    if (type === '06') {
        const addr = parseInt(document.getElementById('encodeAddress').value, 10);
        document.getElementById('encodeValueHint').textContent = WRITE_HINTS[addr] ?? '';
    }
}

function initModeTabs() {
    const tabs = document.querySelectorAll('.mode-tab');
    const decodeSection = document.getElementById('decodeSection');
    const encodeSection = document.getElementById('encodeSection');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const mode = tab.dataset.mode;
            decodeSection.classList.toggle('hidden', mode !== 'decode');
            encodeSection.classList.toggle('hidden', mode !== 'encode');
        });
    });
}

function initDecode() {
    document.getElementById('decodeBtn').addEventListener('click', () => {
        const input = document.getElementById('decodeInput').value.trim();
        const output = document.getElementById('decodeOutput');
        try {
            const bytes = parseHex(input);
            output.textContent = decodePacket(bytes);
            showToast('Пакет декодирован', 'success');
        } catch (e) {
            output.textContent = `Ошибка: ${e.message}`;
            showToast(e.message, 'error');
        }
    });

    document.getElementById('decodeInput').addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('decodeBtn').click();
        }
    });
}

function initEncode() {
    document.getElementById('encodeType').addEventListener('change', updateEncodeFields);
    document.getElementById('encodeAddress').addEventListener('change', updateEncodeFields);

    document.getElementById('encodeBtn').addEventListener('click', () => {
        const type = document.getElementById('encodeType').value;
        const output = document.getElementById('encodeOutput');
        try {
            let packet;
            switch (type) {
            case '27': {
                const cmd = parseInt(document.getElementById('encodeCmd').value, 10);
                const payload = document.getElementById('encodeControlPayload').value;
                packet = encodeControl(cmd, payload);
                break;
            }
            case '07': {
                const addr = parseInt(document.getElementById('encodeAddress').value, 10);
                packet = encodeReadSingle(addr);
                break;
            }
            case '03': {
                const addr = parseInt(document.getElementById('encodeAddress').value, 10);
                const count = parseInt(document.getElementById('encodeParamCount').value, 10);
                packet = encodeReadMultiple(addr, count);
                break;
            }
            case '06': {
                const addr = parseInt(document.getElementById('encodeAddress').value, 10);
                const value = document.getElementById('encodeParamValue').value;
                packet = encodeWriteSingle(addr, value);
                break;
            }
            case '10': {
                const addr = parseInt(document.getElementById('encodeAddress').value, 10);
                const count = parseInt(document.getElementById('encodeParamCount').value, 10);
                const values = document.getElementById('encodeMultiValueList').value
                    .split('\n')
                    .map(s => s.trim())
                    .filter(s => s.length > 0);
                packet = encodeWriteMultiple(addr, count, values);
                break;
            }
            default:
                throw new Error('Неизвестный тип пакета');
            }
            output.textContent = toHex(packet);
            showToast('Пакет собран', 'success');
        } catch (e) {
            output.textContent = '';
            showToast(e.message, 'error');
        }
    });

    document.getElementById('copyBtn').addEventListener('click', async () => {
        const text = document.getElementById('encodeOutput').textContent;
        if (!text) {
            showToast('Нечего копировать', 'error');
            return;
        }
        try {
            await navigator.clipboard.writeText(text);
            showToast('Скопировано', 'success');
        } catch {
            showToast('Не удалось скопировать', 'error');
        }
    });

    updateEncodeFields();
}

document.addEventListener('DOMContentLoaded', () => {
    initModeTabs();
    initDecode();
    initEncode();

    // Пример для быстрого теста
    document.getElementById('decodeInput').value =
        '99 3C 0A 01 14 32';
});
