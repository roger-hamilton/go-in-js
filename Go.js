const fs = require('fs');
const { TextDecoder, TextEncoder } = require('util');
const crypto = require('crypto');

const encoder = new TextEncoder('utf-8');
const decoder = new TextDecoder('utf-8');

class Go {
  constructor(filepath, { debug } = {}) {
    this.source = fs.readFileSync(filepath);
    this.timeOrigin = Date.now() - this.now;
    this.golangProxy = new Proxy({}, {
      get: (target, prop) => {
        if (typeof prop === 'string'){
          let match = /^(?:runtime|syscall\/js)\.(.*)/.exec(prop);
          if (match) return (...args) => {
            if (debug) console.debug(`calling ${prop}(${args.join(', ')})`)
            return this[`${match[1]}`].apply(this, args);
          }
        }

        return this[prop];
      }
    });
    this.env = {};
    this.instance = undefined;
    this.__loadPromise = this.load();
    this.exit = () => { };
  }

  async load() {
    this._refs = new Map();
    
    this._callbackShutdown = false;
    this.exited = false;
    this.running = false;
    const res = await WebAssembly.instantiate(this.source, { go: this.golangProxy });
    this.instance = res.instance;
    this._values = [
      NaN,
      undefined,
      null,
      true,
      false,
      internalGlobal,
      this.instance.exports.mem,
      this,
    ];
  }

  reset() {
    this.__loadPromise = this.load();
  }

  async waitLoaded() {
    await this.__loadPromise;
  }

  async run(...params) {
    await this.__loadPromise;
    if (this.running != false) {
      throw new Error('Go Module already running');
    }

    this.running = true;

    this.debugStartTime = this.now;
    let offset = 4096;

    const strPtr = (str) => {
      let ptr = offset;
      new Uint8Array(this.memRaw, offset, str.length + 1).set(encoder.encode(str + '\0'));
      offset += str.length + (8 - (str.length % 8));
      return ptr;
    };

    const args = ['main.wasm', ...params];

    const argc = args.length;

    // converts array of inputs into an array of pointers to the strings representations of those inputs
    const argvPtrs = args.map(arg => JSON.stringify(arg)).map(strPtr);

    const keys = Object.keys(this.env).sort();
    argvPtrs.push(keys.length);
    keys.forEach((key) => {
      argvPtrs.push(strPtr(`${key}=${this.env[key]}`));
    });

    // store start of pointers
    const argv = offset;

    // write pointers to memory
    argvPtrs.forEach((ptr) => {
      this.setUint32(offset, ptr);
      this.setUint32(offset + 4, 0);
      offset += 8;
    });

    while (true) {
      const callbackPromise = new Promise((resolve) => {
        this._resolveCallbackPromise = () => {
          if (this.exited) {
            throw new Error("bad callback: Go program has already exited");
          }
          setTimeout(resolve, 0); // make sure it is asynchronous
        };
      });
      this.instance.exports.run(argc, argv);
      if (this.exited) {
        break;
      }
      await callbackPromise;
    }
  }

  get now() {
    const [sec, nsec] = process.hrtime();
    return sec * 1000 + nsec / 1000000;
  }

  get mem() {
    return new DataView(this.memRaw);
  }

  get memRaw() {
    return this.instance.exports.mem.buffer;
  }

  get loaded() {
    return !!this.instance;
  }

  //#region golang interop functions

  debug(...args) {
    console.log(...args);
  }

  //#region runtime
  // func wasmExit(code int32)
  wasmExit(addr) {
    const code = this.getInt32(addr + 8);
    this.exited = true;
    delete this._inst;
    delete this._values;
    delete this._refs;
    this.exit(code); // TODO: implement exit
  }
  // func wasmWrite(fd uintptr, p unsafe.Pointer, n int32)
  wasmWrite(addr) {
    const fd = this.getInt64(addr + 8);
    const p = this.getInt64(addr + 16);
    const n = this.getInt32(addr + 24);
    fs.writeSync(fd, new Uint8Array(this.memRaw, p, n));
  }
  // func nanotime() int64
  nanotime(addr) {
    this.setInt64(addr + 8, (this.timeOrigin + this.now) * 1000000);
  }
  // func walltime() (sec int64, nsec int32)
  walltime(addr) {
    const msec = (new Date).getTime();
    this.setInt64(addr + 8, msec / 1000);
    this.setInt32(addr + 16, (msec % 1000) * 1000000);
  };

  // func scheduleCallback(delay int64) int32
  scheduleCallback(addr) {
    const id = this._nextCallbackTimeoutID;
    this._nextCallbackTimeoutID++;
    this._callbackTimeouts.set(id, setTimeout(
      () => { this._resolveCallbackPromise(); },
      this.getInt64(addr + 8) + 1, // setTimeout has been seen to fire up to 1 millisecond early
    ));
    this.setInt32(addr + 16, id);
  };

  // func clearScheduledCallback(id int32)
  clearScheduledCallback(addr) {
    const id = this.mem.getInt32(addr + 8, true);
    clearTimeout(this._callbackTimeouts.get(id));
    this._callbackTimeouts.delete(id);
  };

  // func getRandomData(r []byte)
  getRandomData(sp) {
    crypto.randomFillSync(this.loadSlice(sp + 8));
  };
  //#endregion

  //#region syscall/js
  // func stringVal(value string) ref
  stringVal(addr) {
    this.storeValue(addr + 24, this.loadString(addr + 8));
  }

  // func valueGet(v ref, p string) ref
  valueGet(addr) {
    const obj = this.loadValue(addr + 8);
    const prop = this.loadString(addr + 16);
    
    const val = obj[prop];
    
    this.storeValue(addr + 32, val);
  }

  // func valueSet(v ref, p string, x ref)
  valueSet(addr) {
    const obj = this.loadValue(addr + 8);
    const prop = this.loadString(addr + 16);
    const val = this.loadValue(addr + 32);
    obj[prop] = val;
  }

  // func valueIndex(v ref, i int) ref
  valueIndex(addr) {
    const obj = this.loadValue(addr + 8);
    const idx = this.getInt64(addr + 16);
    this.storeValue(addr + 24, obj[idx]);
  }

  // valueSetIndex(v ref, i int, x ref)
  valueSetIndex(addr) {
    const obj = this.loadValue(addr + 8);
    const idx = this.getInt64(addr + 16);
    const val = this.loadValue(addr + 32);
    obj[idx] = val;
  }

  // func valueCall(v ref, m string, args []ref) (ref, bool)
  valueCall(addr) {
    try {
      const obj = this.loadValue(addr + 8);
      const name = this.loadString(addr + 16);
      const method = obj[name];
      const args = this.loadSliceOfValues(addr + 32);
      this.storeValue(addr + 56, Reflect.apply(method, obj, args));
      this.setUint8(addr + 64, 1);
    } catch (err) {
      this.storeValue(addr + 56, err);
      this.setUint8(addr + 64, 0);
    }
  }

  // func valueInvoke(v ref, args []ref) (ref, bool)
  valueInvoke(addr) {
    try {
      const obj = this.loadValue(addr + 8);
      const args = this.loadSliceOfValues(addr + 16);
      this.storeValue(addr + 40, Reflect.apply(obj, undefined, args));
      this.setUint8(addr + 48, 1);
    } catch (err) {
      this.storeValue(addr + 40, err);
      this.setUint8(addr + 48, 0);
    }
  }

  // func valueNew(v ref, args []ref) (ref, bool)
  valueNew(addr) {
    try {
      const obj = this.loadValue(addr + 8);
      const args = this.loadSliceOfValues(addr + 16);
      this.storeValue(addr + 40, Reflect.construct(obj, args));
      this.setUint8(addr + 48, 1);
    } catch (err) {
      this.storeValue(addr + 40, err);
      this.setUint8(addr + 48, 0);
    }
  }

  // func valueLength(v ref) int
  valueLength(addr) {
    const val = this.loadValue(addr + 8);

    // I do not know why parseInt is used here...
    const len = parseInt(val.length);
    this.setInt64(addr + 16, len);
  }

  // valuePrepareString(v ref) (ref, int)
  valuePrepareString(addr) {
    const str = encoder.encode(String(this.loadValue(addr + 8)));
    this.storeValue(addr + 16, str);
    this.setInt64(addr + 24, str.length);
  }

  // valueLoadString(v ref, b []byte)
  valueLoadString(addr) {
    const str = this.loadValue(addr + 8);
    this.loadSlice(addr + 16).set(str);
  }

  // func valueInstanceOf(v ref, t ref) bool
  valueInstanceOf(addr) {
    const val = this.loadValue(addr + 8);
    const type = this.loadValue(addr + 16);
    this.setUint8(addr + 24, val instanceof type);
  }
  //#endregion

  //#endregion

  //#region memory util

  getInt32(addr) {
    return this.mem.getInt32(addr + 0, true);
  }

  getInt64(addr) {
    const low = this.getInt32(addr + 0);
    const high = this.getInt32(addr + 4);
    return low + high * 4294967296;
  }

  getUint32(addr) {
    return this.mem.getUint32(addr + 0, true);
  }

  getFloat64(addr) {
    return this.mem.getFloat64(addr, true);
  }

  setUint8(addr, val) {
    this.mem.setUint8(addr + 0, val);
  }

  setInt32(addr, val) {
    this.mem.setInt32(addr + 0, val, true);
  }

  setUint32(addr, val) {
    this.mem.setUint32(addr + 0, val, true);
  }

  setInt64(addr, val) {
    this.setUint32(addr + 0, val);
    this.setUint32(addr + 4, Math.floor(val / 4294967296));
  }

  setFloat64(addr, val) {
    this.mem.setFloat64(addr + 0, val, true);
  }

  loadSlice(addr) {
    const array = this.getInt64(addr + 0);
    const len = this.getInt64(addr + 8);
    
    return new Uint8Array(this.memRaw, array, len);
  }

  loadSliceOfValues(addr) {
    const array = this.getInt64(addr + 0);
    const len = this.getInt64(addr + 8);
    const a = new Array(len);
    for (let i = 0; i < len; i++) {
      a[i] = this.loadValue(array + i * 8);
    }
    return a;
  }

  loadString(addr) {
    const saddr = this.getInt64(addr + 0);
    const len = this.getInt64(addr + 8);
    return decoder.decode(new DataView(this.memRaw, saddr, len));
  }

  loadValue(addr) {
    // first try loading float value
    const f = this.getFloat64(addr);
    if (!isNaN(f)) {
      return f;
    }
    const id = this.getUint32(addr);

    return this._values[id];
  }

  storeValue(addr, v) {
    const nanHead = 0x7FF80000;

    if (typeof v === "number") {
      if (isNaN(v)) {
        this.setUint32(addr + 4, nanHead);
        this.setUint32(addr, 0);
        return;
      }
      this.setFloat64(addr, v);
      return;
    }

    switch (v) {
      case undefined:
        this.setUint32(addr + 4, nanHead);
        this.setUint32(addr, 1);
        return;
      case null:
        this.setUint32(addr + 4, nanHead);
        this.setUint32(addr, 2);
        return;
      case true:
        this.setUint32(addr + 4, nanHead);
        this.setUint32(addr, 3);
        return;
      case false:
        this.setUint32(addr + 4, nanHead);
        this.setUint32(addr, 4);
        return;
    }

    let ref = this._refs.get(v);

    if (ref === undefined) {
      ref = this._values.length;
      this._values.push(v);
      this._refs.set(v, ref);
    }

    let typeFlag = 0;
    switch (typeof v) {
      case "string":
        typeFlag = 1;
        break;
      case "symbol":
        typeFlag = 2;
        break;
      case "function":
        typeFlag = 3;
        break;
    }
    this.setUint32(addr + 4, nanHead | typeFlag);
    this.setUint32(addr, ref);
  }

  //#endregion
}

Go._makeCallbackHelper = (id, pendingCallbacks, go) => {
  return function() {
    pendingCallbacks.push({ id: id, args: arguments });
    go._resolveCallbackPromise();
  };
}

Go._makeEventCallbackHelper = (preventDefault, stopPropagation, stopImmediatePropagation, fn) => {
  return function(event) {
    if (preventDefault) {
      event.preventDefault();
    }
    if (stopPropagation) {
      event.stopPropagation();
    }
    if (stopImmediatePropagation) {
      event.stopImmediatePropagation();
    }
    fn(event);
  };
}

const internalGlobal = {
  Object,
  Array,
  Int8Array,
  Int16Array,
  Int32Array,
  Uint8Array,
  Uint16Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  process,
  fs,
  Go,
};

module.exports = Go;