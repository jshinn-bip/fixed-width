export function parseOptions (options) {
  if (Array.isArray(options)) {
    options = { fields: options }
  } else {
    options = Object(options)
  }

  const encoding = options.encoding || 'utf8'
  if (typeof encoding !== 'string') {
    throw new TypeError('Encoding must be a string')
  }

  const pad = options.pad || ' '
  if (typeof pad !== 'string') {
    throw new TypeError('Padding value (pad) must be a string')
  }
  if (pad.length !== 1) {
    throw new Error('Padding value (pad) must be a single char')
  }

  const eol = options.eol || ''
  if (typeof eol !== 'string' && !(eol instanceof RegExp)) {
    throw new TypeError('End of line (eol) value must be a string')
  }

  const from = options.from || 1
  if (!Number.isInteger(from)) {
    throw new TypeError('Starting line (from) must be an integer')
  }

  const to = options.to || Number.POSITIVE_INFINITY
  if (!Number.isInteger(to) && to !== Number.POSITIVE_INFINITY) {
    throw new TypeError('Ending line (to) must be an integer or infinity')
  }
  if (to < from) {
    throw new Error('Ending line (to) must be greater or equal to the starting line (from)')
  }

  const trim = options.trim === 'auto' || options.trim === 'left' || options.trim === 'right'
    ? options.trim
    : options.trim !== false

  const fields = parseFields(options.fields, pad, trim)
  const width = getWidth(fields)

  const properties = fields.reduce(
    (acc, field) => acc + (typeof field.property === 'number' ? 0 : 1),
    0
  )
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

function parseFields (items, pad, trim) {
  if (!Array.isArray(items)) {
    throw new TypeError('Fields option must be an array')
  }
  const fields = []
  let column = 1
  for (let i = 0; i < items.length; i++) {
    const field = parseField(items[i], i, column, pad, trim)
    fields.push(field)
    column += field.width
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

function parseField (field, index, defaultColumn, defaultPad, defaultTrim) {
  if (typeof field !== 'object' || field === null) {
    throw new TypeError('Field definition must be an object')
  }
  if (!isPositiveInteger(field.width)) {
    throw new TypeError('Field width must be a positive integer')
  }

  const column = field.column || defaultColumn
  if (!isPositiveInteger(column)) {
    throw new TypeError('Field column must be a positive integer')
  }

  const pad = field.pad || defaultPad
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
  let analyzing = true
  let column = 1
  let count = 0

  while (analyzing) {
    const field = getNextField(fields, column)
    if (field) {
      column = field.column + field.width
      count++
    } else {
      analyzing = false
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
  const usable = fields.filter(item => item.column >= column)
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

export function isIterable (value) {
  return typeof value !== 'string' && Symbol.iterator in Object(value)
}

export function isAsyncIterable (value) {
  return Symbol.asyncIterator in Object(value)
}
