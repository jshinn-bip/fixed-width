'use strict';

var node_stream = require('node:stream');
var node_string_decoder = require('node:string_decoder');
var os = require('node:os');

class FixedWidthError extends Error {
  constructor (code, message, context = {}) {
    super(message);
    if (Error.captureStackTrace !== undefined) {
      Error.captureStackTrace(this, FixedWidthError);
    }
    this.name = 'FixedWidthError';
    this.code = code;
    for (const key of Object.keys(context)) {
      this[key] = context[key];
    }
  }

  get [Symbol.toStringTag] () {
    return 'Error'
  }

  toString () {
    return `${this.name} [${this.code}]: ${this.message}`
  }
}

function parseOptions (options) {
  if (Array.isArray(options)) {
    options = { fields: options };
  } else {
    options = Object(options);
  }

  const encoding = options.encoding || 'utf8';
  if (typeof encoding !== 'string') {
    throw new TypeError('Encoding must be a string')
  }

  const pad = options.pad || ' ';
  if (typeof pad !== 'string') {
    throw new TypeError('Padding value (pad) must be a string')
  }
  if (pad.length !== 1) {
    throw new Error('Padding value (pad) must be a single char')
  }

  const eol = options.eol || '';
  if (typeof eol !== 'string' && !(eol instanceof RegExp)) {
    throw new TypeError('End of line (eol) value must be a string')
  }

  const from = options.from || 1;
  if (!Number.isInteger(from)) {
    throw new TypeError('Starting line (from) must be an integer')
  }

  const to = options.to || Number.POSITIVE_INFINITY;
  if (!Number.isInteger(to) && to !== Number.POSITIVE_INFINITY) {
    throw new TypeError('Ending line (to) must be an integer or infinity')
  }
  /*if (to < from) {
    throw new Error('Ending line (to) must be greater or equal to the starting line (from)')
  }*/

  const trim = options.trim === 'auto' || options.trim === 'left' || options.trim === 'right'
    ? options.trim
    : options.trim !== false;

  const fields = parseFields$1(options.fields, pad, trim);
  const width = getWidth(fields);

  const properties = fields.reduce(
    (acc, field) => acc + (typeof field.property === 'number' ? 0 : 1),
    0
  );
  if (properties > 0 && properties < fields.length) {
    throw new Error('Target property must be specifier by all fields')
  }

  return {
    allowLongerLines: typeof options.relax === 'boolean'
      ? options.relax
      : options.allowLongerLines !== false,
    allowShorterLines: typeof options.relax === 'boolean'
      ? options.relax
      : options.allowShorterLines === true,
    encoding,
    eof: options.eof !== false,
    eol,
    fields,
    from,
    output: properties > 0 ? 'object' : 'array',
    pad,
    skipEmptyLines: options.skipEmptyLines !== false,
    to,
    trim,
    width
  }
}

function parseFields$1 (items, pad, trim) {
  if (!Array.isArray(items)) {
    throw new TypeError('Fields option must be an array')
  }
  const fields = [];
  let column = 1;
  for (let i = 0; i < items.length; i++) {
    const field = parseField$1(items[i], i, column, pad, trim);
    fields.push(field);
    column += field.width;
  }
  return fields
}

function parseTrimOption (value, defaultValue = true) {
  switch (value) {
    case undefined:
      return defaultValue
    case true:
    case false:
    case 'auto':
    case 'left':
    case 'right':
      return value
    default:
      throw new TypeError(`Invalid trim option: ${value}`)
  }
}

function parseField$1 (field, index, defaultColumn, defaultPad, defaultTrim) {
  if (typeof field !== 'object' || field === null) {
    throw new TypeError('Field definition must be an object')
  }
  if (!isPositiveInteger(field.width)) {
    throw new TypeError('Field width must be a positive integer')
  }

  const column = field.column || defaultColumn;
  if (!isPositiveInteger(column)) {
    throw new TypeError('Field column must be a positive integer')
  }

  const pad = field.pad || defaultPad;
  if (typeof pad !== 'string') {
    throw new TypeError('Padding value (pad) must be a string')
  }
  if (pad.length !== 1) {
    throw new Error('Padding value (pad) must be a single char')
  }

  return {
    align: field.align === 'right' ? 'right' : 'left',
    cast: typeof field.cast === 'function' ? field.cast : null,
    column,
    pad,
    property: isPropertyKey(field.property) ? field.property : index,
    stringify: typeof field.stringify === 'function' ? field.stringify : null,
    trim: parseTrimOption(field.trim, defaultTrim),
    width: field.width
  }
}

function getWidth (fields) {
  let analyzing = true;
  let column = 1;
  let count = 0;

  while (analyzing) {
    const field = getNextField(fields, column);
    if (field) {
      column = field.column + field.width;
      count++;
    } else {
      analyzing = false;
    }
  }

  if (count <= 0) {
    throw new Error('At least one field is required')
  }
  if (count < fields.length) {
    throw new Error('Some fields are overlapping')
  }

  return column - 1
}

function getNextField (fields, column) {
  const usable = fields.filter(item => item.column >= column);
  if (usable.length) {
    return usable.reduce((a, b) => a.column > b.column ? b : a)
  }
}

function isPositiveInteger (value) {
  return Number.isInteger(value) && value > 0
}

function isPropertyKey (value) {
  return typeof value === 'string' || typeof value === 'symbol'
}

function isIterable (value) {
  return typeof value !== 'string' && Symbol.iterator in Object(value)
}

function isAsyncIterable (value) {
  return Symbol.asyncIterator in Object(value)
}

class Parser {
  static stream (options) {
    const parser = new Parser(options);

    return new node_stream.Transform({
      allowHalfOpen: false,
      decodeStrings: true,
      defaultEncoding: parser.options.encoding,
      readableObjectMode: true,
      writableObjectMode: false,
      transform (chunk, encoding, callback) {
        try {
          for (const data of parser.write(chunk)) {
            this.push(data);
          }
          callback();
        } catch (err) {
          callback(err);
        }
      },
      flush (callback) {
        try {
          for (const data of parser.end()) {
            this.push(data);
          }
          callback();
        } catch (err) {
          callback(err);
        }
      }
    })
  }

  constructor (options) {
    this.options = parseOptions(options);

    this.decoder = new node_string_decoder.StringDecoder(this.options.encoding);
    this.line = 1;
    this.text = '';
    this.totalLines = 0;
  }

  * end () {
    if (this.text.length) {
      let outOfRange = false;

      if (this.options.from > 0 && this.line < this.options.from) outOfRange = true;
      if (this.options.from < 0 && this.line < (this.totalLines + 1 + this.options.from)) outOfRange = true;
      if (this.options.to > 0 && this.line > this.options.to) outOfRange = true;
      if (this.options.to < 0 && this.line > (this.totalLines + 1 + this.options.to)) outOfRange = true;

      if (!outOfRange) {
        yield parseFields(
          this.text,
          this.options,
          this.line++
        );
      }
    }

    // Reset internal status
    this.text = '';
    this.line = 1;
    this.totalLines = 0;
  }

  * write (input) {
    this.text += typeof input === 'string'
      ? input
      : this.decoder.write(input);

    if (!this.options.eol) {
      const eol = guessEndOfLine(this.text);
      if (eol) {
        this.options.eol = eol;
      }
    }

    if (this.options.eol) {
      const chunks = this.text.split(this.options.eol);

      // Ignore last line (could be partial)
      this.text = chunks.pop();

      this.totalLines = chunks.length;

      if (this.text.length) this.totalLines += 1;

      for (const chunk of chunks) {
        let outOfRange = false;
        
        if (this.options.from > 0 && this.line < this.options.from) outOfRange = true;
        if (this.options.from < 0 && this.line < (this.totalLines + 1 + this.options.from)) outOfRange = true;
        if (this.options.to > 0 && this.line > this.options.to) outOfRange = true;
        if (this.options.to < 0 && this.line > (this.totalLines + 1 + this.options.to)) outOfRange = true;

        if (outOfRange) {
          this.line++;
          continue;
        }
        
        if (chunk.length > 0 || !this.options.skipEmptyLines) {
          yield parseFields(
            chunk,
            this.options,
            this.line++
          );
        }
      }
    }
  }
}

function parse (input, options) {
  const parser = new Parser(options);

  if (typeof input === 'string' || Buffer.isBuffer(input)) {
    return Array.from(parser.write(input)).concat(Array.from(parser.end()))
  } else if (isIterable(input)) {
    return parseIterable(input, parser)
  } else if (isAsyncIterable(input)) {
    return parseAsyncIterable(input, parser)
  } else {
    throw new TypeError('Expected string, buffer, or iterable')
  }
}

function * parseIterable (iterable, parser) {
  for (const data of iterable) {
    yield * parser.write(data);
  }
  yield * parser.end();
}

async function * parseAsyncIterable (iterable, parser) {
  for await (const data of iterable) {
    yield * parser.write(data);
  }
  yield * parser.end();
}

function parseFields (text, options, line = 1) {
  if (text.length > options.width && !options.allowLongerLines) {
    throw new FixedWidthError(
      'UNEXPECTED_LINE_LENGTH',
      `Line ${line} is longer than expected (see allowLongerLines options)`,
      { line, value: text }
    )
  }
  if (text.length < options.width && !options.allowShorterLines) {
    throw new FixedWidthError(
      'UNEXPECTED_LINE_LENGTH',
      `Line ${line} is shorted than expected (see allowShorterLines options)`,
      { line, value: text }
    )
  }

  if (options.output === 'object') {
    return options.fields.reduce(
      (acc, field) => set(
        acc,
        field.property,
        parseField(text, field, options, line)
      ),
      {}
    )
  } else {
    return options.fields.map(
      field => parseField(text, field, options, line)
    )
  }
}

function parseField (text, field, options, line) {
  const index = field.column - 1;

  const value = trimString(
    text.substring(index, index + field.width),
    field.pad,
    field.trim,
    field.align
  );
  if (!field.cast) {
    return value
  }

  return field.cast(value, {
    column: field.column,
    line,
    width: field.width
  })
}

function set (obj, key, value) {
  obj[key] = value;
  return obj
}

function guessEndOfLine (text) {
  if (/\r\n/.test(text)) {
    // Windows
    return '\r\n'
  }

  const result = text.match(/[\r\n]{1,2}/);
  if (result) {
    if (text[result.index] === '\n') {
      // Linux
      return '\n'
    } else if (text.length > result.index + 1) {
      // Apple
      return '\r'
    }
  }
}

function trimStart (value, pad) {
  let index = 0;
  while (value[index] === pad) {
    index++;
  }
  return value.substring(index)
}

function trimEnd (value, pad) {
  let index = value.length - 1;
  while (value[index] === pad) {
    index--;
  }
  return value.substring(0, index + 1)
}

function trim (value, pad) {
  return trimEnd(trimStart(value, pad), pad)
}

function trimString (value, pad, mode, align) {
  switch (mode) {
    case false:
      return value
    case 'left':
      return trimStart(value, pad)
    case 'right':
      return trimEnd(value, pad)
    case 'auto':
      return align === 'right' ? trimStart(value, pad) : trimEnd(value, pad)
    default:
      return trim(value, pad)
  }
}

class Stringifier {
  static stream (options) {
    const stringifier = new Stringifier(options);

    return new node_stream.Transform({
      allowHalfOpen: false,
      readableObjectMode: false,
      writableObjectMode: true,
      transform (chunk, encoding, callback) {
        let reason = null;
        try {
          this.push(stringifier.write(chunk));
        } catch (err) {
          reason = err;
        }
        callback(reason);
      },
      flush (callback) {
        let reason = null;
        try {
          this.push(stringifier.end());
        } catch (err) {
          reason = err;
        }
        callback(reason);
      }
    })
  }

  constructor (options) {
    this.options = parseOptions(options);
    if (!this.options.eol) {
      this.options = { ...this.options, eol: os.EOL };
    }
    this.line = 1;
  }

  end () {
    this.line = 1;
    return ''
  }

  write (obj) {
    let text = '';
    if (!this.options.eof && this.line > 1) {
      text += this.options.eol;
    }
    text += stringifyFields(obj, this.options, this.line++);
    if (this.options.eof) {
      text += this.options.eol;
    }
    return text
  }
}

function stringify (input, options) {
  const stringifier = new Stringifier(options);

  if (Array.isArray(input)) {
    return Array.from(stringifyIterable(input, stringifier)).join('')
  } else if (isIterable(input)) {
    return stringifyIterable(input, stringifier)
  } else if (isAsyncIterable(input)) {
    return stringifyAsyncIterable(input, stringifier)
  } else {
    throw new TypeError('Expected array or iterable')
  }
}

function * stringifyIterable (iterable, stringifier) {
  for (const data of iterable) {
    yield stringifier.write(data);
  }
  const tail = stringifier.end();
  if (tail) {
    yield tail;
  }
}

async function * stringifyAsyncIterable (iterable, stringifier) {
  for await (const data of iterable) {
    yield stringifier.write(data);
  }
  const tail = stringifier.end();
  if (tail) {
    yield tail;
  }
}

function stringifyFields (obj, options, line = 1) {
  obj = Object(obj);

  let text = ''.padEnd(options.width, options.pad);

  for (const field of options.fields) {
    text = replaceWith(
      text,
      stringifyField(obj, field, options, line),
      field.column - 1
    );
  }

  return text
}

function replaceWith (text, value, index = 0) {
  const before = text.substring(0, index);
  const after = text.substring(index + value.length);
  return before + value + after
}

function stringifyField (obj, field, options, line) {
  let value = obj[field.property];
  if (field.stringify) {
    value = field.stringify(value);
  }
  value = stringifyValue(value, options.encoding);

  if (typeof value !== 'string') {
    throw new FixedWidthError(
      'EXPECTED_STRING_VALUE',
      `Cannot cast to string value on position ${line}:${field.column}`,
      { line, column: field.column, width: field.width, value }
    )
  }

  if (value.length > field.width) {
    throw new FixedWidthError(
      'FIELD_VALUE_OVERFLOW',
      `Value on position ${line}:${field.column} overflow its width`,
      { line, column: field.column, width: field.width, value }
    )
  }

  if (field.align === 'right') {
    value = value.padStart(field.width, field.pad);
  } else {
    value = value.padEnd(field.width, field.pad);
  }

  return value
}

function stringifyValue (value, encoding) {
  return Buffer.isBuffer(value)
    ? value.toString(encoding)
    : stringifyPrimitiveValue(
      typeof value === 'object' && value !== null
        ? value.valueOf()
        : value
    )
}

function stringifyPrimitiveValue (value) {
  if (value === undefined || value === null) {
    return ''
  } else if (typeof value === 'boolean') {
    return value ? '1' : '0'
  } else if (typeof value === 'number' || typeof value === 'bigint') {
    return value.toString(10)
  } else {
    return value
  }
}

exports.FixedWidthError = FixedWidthError;
exports.Parser = Parser;
exports.Stringifier = Stringifier;
exports.parse = parse;
exports.stringify = stringify;
