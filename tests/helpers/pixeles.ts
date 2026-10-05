/**
 * Lee píxeles de un recorte PNG para responder "¿la línea roja se está pintando
 * encima de la etiqueta de la hora?" con números y no con una suposición.
 *
 * El bug era de ORDEN DE PINTADO, no de geometría: la etiqueta vive dentro del
 * `.time-bar-dot` y la línea es su hermano posterior, así que a igual nivel de
 * apilado ganaba el hermano del árbol. La línea estaba bien ubicada en el
 * tiempo (21:12 cae 20px bajo el "9:00 PM", que son 12 minutos a 100px/hora),
 * pero en móvil la etiqueta se ancla a la izquierda DENTRO del punto y la línea
 * entra ~60px dentro de ella: le partía el número en dos.
 *
 * Un test que midiera el `z-index` concreto estaría atado a la solución; este
 * mira el resultado, así que también lo cazaría un cambio de DOM o de orden de
 * pintado.
 *
 * Tipos: el proyecto no instala @types/node, así que el PNG se decodifica con
 * DataView y tipos declarados acá en vez de Buffer. Lo único que se pide afuera
 * es el inflate de zlib, y su forma se declara explícitamente.
 */

export type Px = (x: number, y: number) => [r: number, g: number, b: number];

export interface Imagen {
  w: number;
  h: number;
  px: Px;
}

/** Lo único de zlib que se usa, declarado para no depender de @types/node. */
const zlib = (await import('node:zlib')) as unknown as {
  inflateSync: (datos: Uint8Array) => Uint8Array;
};

export async function leerPixeles(png: Uint8Array): Promise<Imagen> {
  const vista = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const cuatroCC = (i: number) => String.fromCharCode(vista.getUint8(i), vista.getUint8(i + 1), vista.getUint8(i + 2), vista.getUint8(i + 3));

  let pos = 8; // se salta la firma de 8 bytes
  let w = 0, h = 0, profundidad = 0, tipoColor = 0;
  const partes: Uint8Array[] = [];
  while (pos + 8 <= png.length) {
    const largo = vista.getUint32(pos);
    const tipo = cuatroCC(pos + 4);
    if (tipo === 'IHDR') {
      w = vista.getUint32(pos + 8);
      h = vista.getUint32(pos + 12);
      profundidad = vista.getUint8(pos + 16);
      tipoColor = vista.getUint8(pos + 17);
    } else if (tipo === 'IDAT') {
      partes.push(png.subarray(pos + 8, pos + 8 + largo));
    } else if (tipo === 'IEND') {
      break;
    }
    pos += 12 + largo;
  }
  if (profundidad !== 8) throw new Error(`PNG de ${profundidad} bits: el lector solo sabe 8`);
  const canales = tipoColor === 6 ? 4 : tipoColor === 2 ? 3 : tipoColor === 0 ? 1 : 4;

  const crudo = zlib.inflateSync(concat(partes));
  const stride = w * canales;
  const pix = new Uint8Array(stride * h);
  let previa = new Uint8Array(stride);
  let i = 0;
  for (let y = 0; y < h; y++) {
    const filtro = crudo[i++];
    const fila = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const crudo_ = crudo[i + x];
      const a = x >= canales ? fila[x - canales] : 0;
      const b = previa[x];
      const c = x >= canales ? previa[x - canales] : 0;
      let valor = crudo_;
      if (filtro === 1) valor = crudo_ + a;
      else if (filtro === 2) valor = crudo_ + b;
      else if (filtro === 3) valor = crudo_ + ((a + b) >> 1);
      else if (filtro === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        valor = crudo_ + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      fila[x] = valor & 0xff;
    }
    i += stride;
    pix.set(fila, y * stride);
    previa = fila;
  }

  return {
    w,
    h,
    px: (x, y) => {
      const o = y * stride + x * canales;
      return canales === 1 ? [pix[o], pix[o], pix[o]] : [pix[o], pix[o + 1], pix[o + 2]];
    }
  };
}

function concat(partes: Uint8Array[]): Uint8Array {
  const total = partes.reduce((n, p) => n + p.length, 0);
  const salida = new Uint8Array(total);
  let i = 0;
  for (const p of partes) { salida.set(p, i); i += p.length; }
  return salida;
}

/** Rojo sólido: el fondo de la etiqueta (#c53030). */
export function esRojoSolido(r: number, g: number, b: number): boolean {
  return g < 110 && b < 110 && r > 120;
}

/**
 * Rojo al 50%: la línea de 2px con opacity .5. El criterio es "el canal verde
 * claramente menor que el rojo" para no depender del fondo que tenga debajo.
 */
export function esRojoDeLinea(r: number, g: number, b: number): boolean {
  return r - g > 30 && g >= 110 && g < 200 && b - g < 40;
}