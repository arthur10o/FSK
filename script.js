const CANVAS_RAW = document.getElementById('spectrum');
const CANVAS_FILTERED = document.getElementById('filtered');
const RECEIVER_RAW = CANVAS_RAW.getContext('2d');
const RECEIVER_FILTERED = CANVAS_FILTERED.getContext('2d');

const SIGNAL_ELEMENT = document.getElementById('signal');
const BITS_ELEMENT = document.getElementById('bits');
const RESULT_ELEMENT = document.getElementById('result');
const SEND_ELEMENT = document.getElementById('send');

const PATTERN_DURATION = 1;
const PREAMBLE_DURATION = 2;

const BITS_FREQS_DICT = {
    '0000': 2500,
    '0001': 2800,
    '0010': 3100,
    '0011': 3400,
    '0100': 3700,
    '0101': 4000,
    '0110': 4300,
    '0111': 4600,
    '1000': 4900,
    '1001': 5200,
    '1010': 5500,
    '1011': 5800, 
    '1100': 6100,
    '1101': 6400,
    '1110': 6700,
    '1111': 7000,
};
const PREAMBLE_FREQ = 1000;
const SIZE_BITS = Object.keys(BITS_FREQS_DICT)[0].length;

const DEST_ID_SEPARATOR = '<!#DID#>';
const SENDER_ID_SEPARATOR = '<!#SID#>';
const DATA_SEPARATOR = '<!#DTA#>';
const END = '<!#END#>';

const STATES = {
    WAITING_PREAMBLE: 0,
    READING_DEST_ID: 1,
    READING_SENDER_ID: 2,
    READING_DEVICE_ID: 3,
    READING_DATA: 4,
};

const FREQS = Object.values(BITS_FREQS_DICT);

let audio_context = null;
let analyser_raw = null;
let analyser_filtered = null;

let data_array_raw = null;
let data_array_filtered = null;

let receiver = null;
let is_sending = false;

let device_id = null;

document.addEventListener('DOMContentLoaded', async () => {
    device_id = localStorage.getItem('device_id');
    if (!device_id) {
        device_id = crypto.randomUUID();
        localStorage.setItem('device_id', device_id);
    }
    document.getElementById('your_id').textContent = 'Your ID: ' + device_id;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    await init(stream);
    loop();
});

SEND_ELEMENT.addEventListener('click', async function () {
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    is_sending = true;
    SEND_ELEMENT.disabled = true;
    const DEST_ID = document.getElementById('destinataire_id').value;
    const DATA_TO_SEND = document.getElementById('input').value;
    const PACKET = (DEST_ID_SEPARATOR + DEST_ID
                    + SENDER_ID_SEPARATOR + device_id
                    + DATA_SEPARATOR + DATA_TO_SEND
                    + END ).split('').map(c => c.charCodeAt(0).toString(2).padStart(8,'0')).join('');
    console.log(DEST_ID_SEPARATOR + DEST_ID + SENDER_ID_SEPARATOR + device_id + DATA_SEPARATOR + DATA_TO_SEND + END);
    if (!audio_context) return;
    console.log(PACKET);
    let current_time = audio_context.currentTime;
    let current_pair = 0;
    const TOTAL_PAIRS = Math.floor(PACKET.length / SIZE_BITS);
    await play_sound(PREAMBLE_FREQ, current_time);
    current_time += PREAMBLE_DURATION;
    for (let index = 0; index < PACKET.length; index += SIZE_BITS) {
        const CHUNK = PACKET.slice(index, index + SIZE_BITS);
        if (CHUNK.length < SIZE_BITS) continue;
        const FREQ = BITS_FREQS_DICT[CHUNK];
        if (!Number.isFinite(FREQ)) continue;
        await play_sound(FREQ, current_time);
        current_time += PATTERN_DURATION;
        current_pair ++;
        const PROGRESS = ((current_pair / TOTAL_PAIRS) * 100).toFixed(2);
        document.getElementById('progress_send').textContent = `Envoi: ${PROGRESS}%`;
        await sleep(PATTERN_DURATION * 1000);
    }
    setTimeout(() => {
        is_sending = false;
        SEND_ELEMENT.disabled = false;
    }, ((PACKET.length / SIZE_BITS) * PATTERN_DURATION * 1000) + PATTERN_DURATION * 1000);
})

class Receiver {
    constructor(audio_context, analyser, bits_freqs_dict, pattern_duration) {
        this.audio_context = audio_context;
        this.analyser = analyser;
        this.bits_freqs_dict = bits_freqs_dict;
        this.pattern_duration = pattern_duration;

        this.bit_buffer = '';
        this.data_buffer = '';
        this.current_bit = null;
        this.bit_sample = [];
        this.bit_start_time = 0;
        this.last_signal_time = 0;
        this.start_time = audio_context.currentTime;
        this.receiving = false;

        this.debug_freq = 0;
        this.debug_bit = null;
        this.debug_duration = 0;

        this.state = STATES.WAITING_PREAMBLE;
        this.sender_id = null;
        this.device_id = null;
        this.current_section = '';
    }

    detect_bit() {
        const NOW = this.audio_context.currentTime;
        if (NOW - this.start_time < 1) return;      // Skip fist second
        const DATA = new Uint8Array(this.analyser.frequencyBinCount);
        this.analyser.getByteFrequencyData(DATA);
        if (this.state == STATES.WAITING_PREAMBLE) {
            const PREAMBLE_INDEX = Math.round(PREAMBLE_FREQ * this.analyser.fftSize / this.audio_context.sampleRate);
            const PREAMBLE_POWER = DATA[PREAMBLE_INDEX-1] + DATA[PREAMBLE_INDEX] + DATA[PREAMBLE_INDEX+1];
            if (PREAMBLE_POWER > 80) {
                if (!this.preamble_start) this.preamble_start = NOW;
                if (NOW - this.preamble_start >= 1.5) {
                    console.log('SYNC OK');
                    this.state = STATES.READING_DEST_ID;
                    this.bit_buffer = '';
                    this.current_section = '';
                } 
            } else {
                this.preamble_start = null;
            }
        }
        let bestBit = null;
        let bestPower = 0;
        for (const [key, freq] of Object.entries(this.bits_freqs_dict)) {
            const index = Math.round(freq * this.analyser.fftSize / this.audio_context.sampleRate);
            const power = DATA[index-1] + DATA[index] + DATA[index+1];

            if (power > bestPower) {
                bestPower = power;
                bestBit = key;
            }
        }

        if (bestPower < 40) return;
        let bit = bestBit
        const noiseFloor = DATA.reduce((a,b)=>a+b,0)/DATA.length;
        const STRONG_SIGNAL = bestPower > noiseFloor * 4;
        if (bestPower < 40 || !STRONG_SIGNAL) return;
        if (!bit) {
            this.missing_frames = (this.missing_frames ?? 0) + 1;
            if (this.missing_frames < 3) return;
        } else {
            this.missing_frames = 0;
        }
        if (bit == this.current_bit) {
            const DURATION = NOW - this.bit_start_time;
            this.debug_duration = DURATION;
            this.bit_sample.push(bit);
            if (this.bit_sample.length >= 3) {
                const same = this.bit_sample.every(b => b === bit);

                if (same) {
                    const DURATION = NOW - this.bit_start_time;
                    if (DURATION >= this.pattern_duration) {
                        this.commit_bit(NOW);
                        this.bit_sample = [];
                    }
                }
            }
            return;
        }
        this.flush_bit(NOW);
        this.current_bit = bit;
        this.bit_start_time = NOW;
    }

    commit_bit(now) {
        if (!this.current_bit) return;
        this.bit_buffer += this.current_bit;
        BITS_ELEMENT.textContent = this.bit_buffer;
        this.bit_start_time = now;
        while (this.bit_buffer.length >= 8) {
            const BITE = this.bit_buffer.slice(0, 8);
            const VALUE = parseInt(BITE, 2);
            if (!Number.isNaN(VALUE)) {
                this.current_section += String.fromCharCode(VALUE);
            }
            this.bit_buffer = this.bit_buffer.slice(8);
        }
        console.log(this.current_section);
        console.log(this.state);
        console.log({
            sender_id: this.sender_id,
            receiver_id: this.device_id,
        });
        if (this.state == STATES.READING_DEST_ID) {
            if (this.current_section.includes(DEST_ID_SEPARATOR)) {
                this.state = STATES.READING_SENDER_ID;
                this.current_section = '';
            }
        } else if (this.state == STATES.READING_SENDER_ID) {
            if (this.current_section.includes(SENDER_ID_SEPARATOR)) {
                this.device_id = this.current_section.split(SENDER_ID_SEPARATOR)[0];
                this.state = STATES.READING_DEVICE_ID;
                this.current_section = '';
            }
        } else if (this.state == STATES.READING_DEVICE_ID) {
            if (this.current_section.includes(DATA_SEPARATOR)) {
                this.sender_id = this.current_section.split(DATA_SEPARATOR)[0];
                document.getElementById('destinataire_id').value = this.sender_id;
                this.state = STATES.READING_DATA;
                this.current_section = '';
            }
        } else  if (this.state == STATES.READING_DATA) {
            if (this.current_section.includes(END)) {
                const DATA = this.current_section.split(END)[0];
                RESULT_ELEMENT.textContent = DATA;
                this.state = STATES.WAITING_PREAMBLE;
                this.current_section = '';
            }
        }
    }

    finalize_current_bit(now) {
        if(!this.current_bit) return;
        const DURATION = now - this.bit_start_time;
        if (DURATION >= this.pattern_duration * 0.8) this.commit_bit(now);
        this.current_bit = null;
        this.bit_start_time = 0;
    }

    flush_bit(now) {
        if (!this.current_bit) return;
        const DURATION = now - this.bit_start_time;
        if (DURATION >= this.pattern_duration * 0.8) this.commit_bit(now);
        this.current_bit = null;
        this.bit_start_time = 0;
        this.bit_sample = [];
    }
};

async function init(stream) {
    audio_context = new AudioContext();
    const SOURCE = audio_context.createMediaStreamSource(stream);

    analyser_raw = audio_context.createAnalyser();
    analyser_raw.fftSize = 2048;
    data_array_raw = new Uint8Array(analyser_raw.frequencyBinCount);

    analyser_filtered = audio_context.createAnalyser();
    analyser_filtered.fftSize = 4096;
    analyser_filtered.smoothingTimeConstant = 0.3;
    data_array_filtered = new Uint8Array(analyser_filtered.frequencyBinCount);

    const FILTER = audio_context.createBiquadFilter();
    FILTER.type = 'bandpass';
    FILTER.frequency.value = FREQS.reduce((a, b) => a + b) / FREQS.length;
    FILTER.Q.value = 5;
    SOURCE.connect(analyser_raw);
    SOURCE.connect(FILTER);
    FILTER.connect(analyser_filtered);

    receiver = new Receiver(audio_context, analyser_filtered, BITS_FREQS_DICT, PATTERN_DURATION)
}

function draw_spectrum(analyser, data_array, is_filtered) {
    analyser.getByteFrequencyData(data_array);

    const CANVAS = is_filtered ? CANVAS_FILTERED : CANVAS_RAW;
    const RECEIVER = is_filtered ? RECEIVER_FILTERED : RECEIVER_RAW;

    RECEIVER.clearRect(0, 0, CANVAS.width, CANVAS.height);

    const BAR_WIDTH = CANVAS.width / data_array.length;

    for (let index = 0; index < data_array.length; index++) {
        const VALUE = data_array[index];
        const HEIGHT = (VALUE / 255) * CANVAS.height;
        
        RECEIVER.fillStyle = is_filtered
            ? "rgba(255,0,0,0.5)"
            : `rgb(${VALUE}, 50, 50)`;
        RECEIVER.fillRect(index * BAR_WIDTH, CANVAS.height - HEIGHT, BAR_WIDTH, HEIGHT);
    }
}

async function play_sound(freq, t0) {
    let delta_t = null;
    if (freq == PREAMBLE_FREQ) delta_t = PREAMBLE_DURATION;
    else delta_t = PATTERN_DURATION;
    const CONTEXT = audio_context;
    if (!CONTEXT) return;
    const OSCILLATOR = CONTEXT.createOscillator();
    OSCILLATOR.type = 'sine';
    OSCILLATOR.frequency.value = freq;
    OSCILLATOR.connect(CONTEXT.destination);
    OSCILLATOR.start(t0);
    OSCILLATOR.stop(t0 + delta_t);
}

function loop() {
    requestAnimationFrame(loop);
    if (analyser_raw && data_array_raw) draw_spectrum(analyser_raw, data_array_raw, false);
    if (analyser_filtered && data_array_filtered) draw_spectrum(analyser_filtered, data_array_filtered, true);
    if (receiver && is_sending == false) receiver.detect_bit();
    SIGNAL_ELEMENT.textContent = receiver ? receiver.debug_freq.toFixed(1) : '';
    document.getElementById('debug').innerHTML = `
    bit: <b>${receiver?.debug_bit ?? '-'}</b><br>
    freq: <b>${receiver?.debug_freq?.toFixed(0) ?? '-'}</b><br>
    durée: <b>${receiver?.debug_duration?.toFixed(2) ?? '-'}</b>
    `;
}

// TODO:
// - Améliorer la robustesse:
//   - Ajouter un préambule pour synchroniser l'émetteur et le récepteur
//   - Ajouter des bits de parité ou de checksum pour détecter les erreurs
// - Améliorer l'interface utilisateur:
//   - Afficher une liste des messages reçus
// - Sécuriser les communications:
//   - Chiffrer les données avant de les envoyer