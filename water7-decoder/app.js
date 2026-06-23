'use strict';

const BOARD_REVISIONS = {
    0: 'Rev 1 Green',
    1: 'Rev 2 White',
};

const PARAMS = {
    0: {
        name: 'Humidity',
        rw: 'RW',
        source: 'первый online датчик RS-485',
        writeRange: '0…100',
        decode: v => `${v} %`,
    },
    1: {
        name: 'Conductivity',
        rw: 'RW',
        source: 'первый online датчик RS-485',
        writeRange: '0…65535',
        decode: v => `${v} µS/cm`,
    },
    2: {
        name: 'Temperature',
        rw: 'RW',
        source: 'первый online датчик RS-485',
        writeRange: '−5000…20500 (сотые °C)',
        decode: v => `${(v / 100).toFixed(2)} °C (raw ${v})`,
    },
    3: {
        name: 'Battery',
        rw: 'RO',
        source: 'vdda_mv (VREFINT)',
        decode: v => `${v} mV`,
    },
    11: {
        name: 'WakeFirstMin',
        rw: 'RW',
        source: 'settings.wake_first_min, persist flash',
        writeRange: '0…1439',
        decode: decodeWakeFirstMin,
    },
    12: {
        name: 'WakePeriodMin',
        rw: 'RW',
        source: 'settings.wake_period_min, persist flash',
        writeRange: '1…1440',
        decode: decodeWakePeriodMin,
    },
    13: {
        name: 'WakeCount',
        rw: 'RW',
        source: 'settings.wake_count, persist flash',
        writeRange: '0…255 (0 = нет автоопроса)',
        decode: decodeWakeCount,
    },
    100: {
        name: 'ProtocolVersion',
        rw: 'RO',
        source: 'константа прошивки',
        decode: v => `${v}`,
    },
    101: {
        name: 'SensorType',
        rw: 'RO',
        source: 'ConfigBlock',
        decode: decodeSensorType,
    },
    102: {
        name: 'BoardRevision',
        rw: 'RO',
        source: 'ConfigBlock',
        decode: decodeBoardRevision,
    },
    103: {
        name: 'FirmwareVersion',
        rw: 'RO',
        source: 'константа прошивки',
        decode: decodePackedDate,
    },
    104: {
        name: 'ManufactureDate',
        rw: 'RO',
        source: 'ConfigBlock',
        decode: decodePackedDate,
    },
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
    5: { name: 'SETTINGS_CHANGED', decode: () => 'расписание wake (11–13) записано' },
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
    11: '0…1439 (мин от 00:00 UTC)',
    12: '1…1440 мин',
    13: '0…255 (0 = нет автоопроса)',
};

function decodeSensorType(v) {
    const map = { 0: 'unknown', 1: 'SOIL_RS485' };
    const id = v & 0xFF;
    return `${map[id] ?? 'неизвестно'} (${id})`;
}

function decodeBoardRevision(v) {
    const rev = v & 0xFF;
    const name = BOARD_REVISIONS[rev];
    return name ? `${name} (rev ${rev})` : `rev ${rev} (неизвестная)`;
}

function decodePackedDate(v) {
    const year = (v >> 10) & 0x3FFF;
    const month = (v >> 6) & 0x0F;
    const day = v & 0x3F;
    return `${year}.${String(month).padStart(2, '0')}.${String(day).padStart(2, '0')}`;
}

function decodeWakeFirstMin(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${min} мин (${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} UTC)`;
}

function decodeWakePeriodMin(min) {
    if (min < 60) return `${min} мин`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    const parts = [`${min} мин`];
    const human = [];
    if (h > 0) human.push(`${h} ч`);
    if (m > 0) human.push(`${m} мин`);
    if (human.length) parts.push(`(${human.join(' ')})`);
    return parts.join(' ');
}

function decodeWakeCount(n) {
    if (n === 0) return '0 (нет автоопроса)';
    return `${n}`;
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

function formatParamMeta(addr) {
    const p = PARAMS[addr];
    if (!p) {
        return `Param [${addr}] — неизвестный адрес`;
    }
    const lines = [`${p.name} [${addr}] (${p.rw})`];
    if (p.source) {
        lines.push(`  источник: ${p.source}`);
    }
    return lines.join('\n');
}

function formatParam(addr, raw) {
    const p = PARAMS[addr];
    if (!p) {
        return [
            `Param [${addr}] — неизвестный адрес`,
            `  значение: ${raw}`,
            `  raw int32 BE: ${raw} (0x${(raw >>> 0).toString(16).toUpperCase().padStart(8, '0')})`,
        ].join('\n');
    }

    const lines = [
        `${p.name} [${addr}] (${p.rw})`,
        `  значение: ${p.decode(raw)}`,
        `  raw int32 BE: ${raw}`,
    ];
    if (p.source) {
        lines.push(`  источник: ${p.source}`);
    }
    if (p.writeRange) {
        lines.push(`  диапазон записи: ${p.writeRange}`);
    }
    return lines.join('\n');
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
            lines.push(formatParam(addr + i, val));
            if (i < count - 1) lines.push('');
        }
    } else if (bytes.length === 5) {
        lines.push('Параметры:');
        for (let i = 0; i < count; i++) {
            lines.push(formatParamMeta(addr + i));
            if (i < count - 1) lines.push('');
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
    } else if (isRequest) {
        lines.push(formatParamMeta(addr));
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
            lines.push(formatParam(addr + i, val));
            if (i < count - 1) lines.push('');
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
    const isRequest = bytes.length === 6;
    const isResponse = bytes.length === 7;

    const lines = [];
    lines.push('Тип: Control 0x27');
    lines.push(`Длина: ${bytes.length} байт (ожид. 6 запрос / 7 ответ)`);

    if (isRequest) {
        const payload = readBE32(bytes, 2);
        lines.push('Направление: запрос DL');
        lines.push(`Команда: ${cmd} — ${COMMANDS[cmd] ?? `неизвестная (${cmd})`}`);
        if (payload !== 0) {
            lines.push(`Payload: ${payload}`);
        }
    } else if (isResponse) {
        const status = bytes[2];
        const payload = readBE32(bytes, 3);
        lines.push('Направление: ответ UL');
        lines.push(`Команда: ${cmd} — ${COMMANDS[cmd] ?? `неизвестная (${cmd})`}`);
        if (status === 0) {
            lines.push('Status: 0 (OK)');
        } else {
            const errName = ERROR_CODES[status];
            lines.push(`Status: ${status}${errName ? ` — ${errName}` : ''}`);
        }
        if (payload !== 0) {
            lines.push(`Payload: ${payload}`);
        }
    } else {
        lines.push('Предупреждение: нестандартная длина пакета');
        if (bytes.length >= 3) {
            lines.push(`Команда: ${cmd} — ${COMMANDS[cmd] ?? `неизвестная (${cmd})`}`);
        }
        if (bytes.length >= 7) {
            lines.push(`Status: ${bytes[2]}`);
            lines.push(`Payload: ${readBE32(bytes, 3)}`);
        } else if (bytes.length >= 6) {
            lines.push(`Payload: ${readBE32(bytes, 2)}`);
        }
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
    return [0x27, cmd, ...writeBE32(p)];
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
        const v = typeof raw === 'number' ? raw : parseInt(String(raw).trim(), 10);
        if (Number.isNaN(v)) throw new Error(`Некорректное значение: ${raw}`);
        packet.push(...writeBE32(v));
    }
    return packet;
}

const MINUTES_PER_DAY = 1440;

function formatTimeUTC(minute) {
    const h = Math.floor(minute / 60);
    const m = minute % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function parseTimeToMinutes(timeStr) {
    const parts = timeStr.split(':');
    if (parts.length < 2) throw new Error('Некорректное время');
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) {
        throw new Error('Время должно быть 00:00…23:59 UTC');
    }
    return h * 60 + m;
}

function readScheduleInputs() {
    const firstMin = parseTimeToMinutes(document.getElementById('scheduleFirstTime').value);
    const preset = document.getElementById('schedulePeriodPreset').value;
    let periodMin;
    if (preset === 'custom') {
        periodMin = parseInt(document.getElementById('schedulePeriodMin').value, 10);
    } else {
        periodMin = parseInt(preset, 10);
    }
    const count = parseInt(document.getElementById('scheduleCount').value, 10);
    if (Number.isNaN(periodMin) || periodMin < 1 || periodMin > 1440) {
        throw new Error('Интервал: 1…1440 мин');
    }
    if (Number.isNaN(count) || count < 0 || count > 255) {
        throw new Error('Опросов в сутки: 0…255');
    }
    if (firstMin < 0 || firstMin > 1439) {
        throw new Error('Первый опрос: 0…1439 мин от полуночи UTC');
    }
    return { firstMin, periodMin, count };
}

function computeScheduleSlots(firstMin, periodMin, count) {
    const slots = [];
    let overflow = false;
    for (let i = 0; i < count; i++) {
        const minute = firstMin + i * periodMin;
        if (minute >= MINUTES_PER_DAY) {
            overflow = true;
            break;
        }
        slots.push(minute);
    }
    return { slots, overflow };
}

function buildSchedulePreviewText({ firstMin, periodMin, count }) {
    if (count === 0) {
        return { text: 'автоопрос отключён (WakeCount = 0)', warn: false };
    }
    const { slots, overflow } = computeScheduleSlots(firstMin, periodMin, count);
    if (slots.length === 0) {
        return { text: 'внимание: переполнение дня', warn: true };
    }
    const last = formatTimeUTC(slots[slots.length - 1]);
    if (overflow) {
        return { text: 'внимание: переполнение дня', warn: true };
    }
    if (slots.length === 1) {
        return { text: `опрос в ${last} UTC`, warn: false };
    }
    return { text: `последний опрос в ${last} UTC`, warn: false };
}

function updateSchedulePreview() {
    const el = document.getElementById('schedulePreview');
    if (!el) return;
    try {
        const data = readScheduleInputs();
        const { text, warn } = buildSchedulePreviewText(data);
        el.textContent = text;
        el.classList.toggle('warn', warn);
    } catch (e) {
        el.textContent = e.message;
        el.classList.add('warn');
    }
}

function encodeSchedulePacket() {
    const { firstMin, periodMin, count } = readScheduleInputs();
    return encodeWriteMultiple(11, 3, [firstMin, periodMin, count]);
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
        encodeSchedule: type === 'schedule',
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

    if (type === 'schedule') {
        updateSchedulePreview();
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

function initScheduleEncode() {
    const ids = [
        'scheduleFirstTime', 'schedulePeriodPreset', 'schedulePeriodMin', 'scheduleCount',
    ];
    for (const id of ids) {
        document.getElementById(id).addEventListener('input', updateSchedulePreview);
        document.getElementById(id).addEventListener('change', updateSchedulePreview);
    }
    document.getElementById('schedulePeriodPreset').addEventListener('change', () => {
        const custom = document.getElementById('schedulePeriodPreset').value === 'custom';
        document.getElementById('schedulePeriodMin').classList.toggle('hidden', !custom);
    });
}

function initEncode() {
    document.getElementById('encodeType').addEventListener('change', updateEncodeFields);
    document.getElementById('encodeAddress').addEventListener('change', updateEncodeFields);
    initScheduleEncode();

    document.getElementById('encodeBtn').addEventListener('click', () => {
        const type = document.getElementById('encodeType').value;
        const output = document.getElementById('encodeOutput');
        try {
            let packet;
            switch (type) {
            case 'schedule':
                packet = encodeSchedulePacket();
                break;
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
            output.textContent = toHex(packet, '');
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
