/**
 * Argon Play - shared ground for the content scripts.
 *
 * Nothing here touches YouTube. It builds DOM, talks to the background worker, and decides which
 * of the tracks an instance offered this browser can actually decode.
 */

(() => {
  const api = globalThis.browser ?? globalThis.chrome;

  const Argon = {
    api,

    /** Every element is built node by node: youtube.com enforces Trusted Types, and innerHTML
     *  from an isolated world still trips it in current Chrome. */
    el(tag, props = {}, children = []) {
      const node = document.createElement(tag);

      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined) continue;

        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'style') Object.assign(node.style, value);
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
        else node.setAttribute(key, value);
      }

      for (const child of [].concat(children)) {
        if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
      }

      return node;
    },

    /**
     * An icon is its viewBox, its paths, and whether it is drawn filled or stroked.
     *
     * The control icons are YouTube's own, lifted from the running player so the bar is theirs
     * down to the glyph - solid fills on a 36 or 24 grid. Where YouTube's player has no icon for
     * something Argon Play does, the gap is filled from Lucide, which is stroked on a 24 grid.
     */
    icon(spec, { size = 24 } = {}) {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');

      svg.setAttribute('viewBox', spec.box);
      svg.setAttribute('width', String(size));
      svg.setAttribute('height', String(size));
      svg.setAttribute('aria-hidden', 'true');

      if (spec.stroke) {
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
      } else {
        svg.setAttribute('fill', 'currentColor');
      }

      for (const entry of spec.d) {
        const shape = document.createElementNS(ns, 'path');

        // An entry may carry its own opacity, which the Argon mark needs for its held-back A.
        shape.setAttribute('d', typeof entry === 'string' ? entry : entry.d);

        if (typeof entry !== 'string' && entry.opacity !== undefined) {
          shape.setAttribute('fill-opacity', String(entry.opacity));
        }

        svg.appendChild(shape);
      }

      return svg;
    },

    ICONS: {
      // ---------------------------------------------------- YouTube's own
      play: {
        box: '0 0 36 36',
        d: ['M 17 8.6 L 10.89 4.99 C 9.39 4.11 7.5 5.19 7.5 6.93 L 7.5 29.06 C 7.5 30.8 9.39 31.88 10.89 31 L 17 27.4 L 17 8.6 Z M 17 8.6 V 27.4 L 33 18 V 18 L 17 8.6 Z'],
      },
      pause: {
        box: '0 0 36 36',
        d: ['M 12.75 4.5 L 9.75 4.5 C 9.15 4.5 8.58 4.73 8.15 5.15 C 7.73 5.58 7.5 6.15 7.5 6.75 L 7.5 29.25 C 7.5 29.84 7.73 30.41 8.15 30.84 C 8.58 31.26 9.15 31.5 9.75 31.5 L 12.75 31.5 C 13.34 31.5 13.91 31.26 14.34 30.84 C 14.76 30.41 15 29.84 15 29.25 L 15 6.75 C 15 6.15 14.76 5.58 14.34 5.15 C 13.91 4.73 13.34 4.5 12.75 4.5 Z M 26.25 4.5 L 23.25 4.5 C 22.65 4.5 22.08 4.73 21.65 5.15 C 21.23 5.58 21 6.15 21 6.75 V 29.25 C 21 29.84 21.23 30.41 21.65 30.84 C 22.08 31.26 22.65 31.5 23.25 31.5 L 26.25 31.5 C 26.84 31.5 27.41 31.26 27.84 30.84 C 28.26 30.41 28.5 29.84 28.5 29.25 V 6.75 C 28.5 6.15 28.26 5.58 27.84 5.15 C 27.41 4.73 26.84 4.5 26.25 4.5 Z'],
      },
      volume: {
        box: '0 0 24 24',
        d: [
          'M 11.60 2.08 L 11.48 2.14 L 3.91 6.68 C 3.02 7.21 2.28 7.97 1.77 8.87 C 1.26 9.77 1.00 10.79 1 11.83 V 12.16 L 1.01 12.56 C 1.07 13.52 1.37 14.46 1.87 15.29 C 2.38 16.12 3.08 16.81 3.91 17.31 L 11.48 21.85 C 11.63 21.94 11.80 21.99 11.98 21.99 C 12.16 22.00 12.33 21.95 12.49 21.87 C 12.64 21.78 12.77 21.65 12.86 21.50 C 12.95 21.35 13 21.17 13 21 V 3 C 12.99 2.83 12.95 2.67 12.87 2.52 C 12.80 2.37 12.68 2.25 12.54 2.16 C 12.41 2.07 12.25 2.01 12.08 2.00 C 11.92 1.98 11.75 2.01 11.60 2.08 Z',
          'M 15.53 7.05 C 15.35 7.22 15.25 7.45 15.24 7.70 C 15.23 7.95 15.31 8.19 15.46 8.38 L 15.53 8.46 L 15.70 8.64 C 16.09 9.06 16.39 9.55 16.61 10.08 L 16.70 10.31 C 16.90 10.85 17 11.42 17 12 L 16.99 12.24 C 16.96 12.73 16.87 13.22 16.70 13.68 L 16.61 13.91 C 16.36 14.51 15.99 15.07 15.53 15.53 C 15.35 15.72 15.25 15.97 15.26 16.23 C 15.26 16.49 15.37 16.74 15.55 16.92 C 15.73 17.11 15.98 17.21 16.24 17.22 C 16.50 17.22 16.76 17.12 16.95 16.95 C 17.6 16.29 18.11 15.52 18.46 14.67 L 18.59 14.35 C 18.82 13.71 18.95 13.03 18.99 12.34 L 19 12 C 18.99 11.19 18.86 10.39 18.59 9.64 L 18.46 9.32 C 18.15 8.57 17.72 7.89 17.18 7.3 L 16.95 7.05 L 16.87 6.98 C 16.68 6.82 16.43 6.74 16.19 6.75 C 15.94 6.77 15.71 6.87 15.53 7.05',
          'M18.36 4.22C18.18 4.39 18.08 4.62 18.07 4.87C18.05 5.12 18.13 5.36 18.29 5.56L18.36 5.63L18.66 5.95C19.36 6.72 19.91 7.60 20.31 8.55L20.47 8.96C20.82 9.94 21 10.96 21 11.99L20.98 12.44C20.94 13.32 20.77 14.19 20.47 15.03L20.31 15.44C19.86 16.53 19.19 17.52 18.36 18.36C18.17 18.55 18.07 18.80 18.07 19.07C18.07 19.33 18.17 19.59 18.36 19.77C18.55 19.96 18.80 20.07 19.07 20.07C19.33 20.07 19.59 19.96 19.77 19.77C20.79 18.75 21.61 17.54 22.16 16.20L22.35 15.70C22.72 14.68 22.93 13.62 22.98 12.54L23 12C22.99 10.73 22.78 9.48 22.35 8.29L22.16 7.79C21.67 6.62 20.99 5.54 20.15 4.61L19.77 4.22L19.70 4.15C19.51 3.99 19.26 3.91 19.02 3.93C18.77 3.94 18.53 4.04 18.36 4.22 Z',
        ],
      },
      muted: {
        box: '0 0 24 24',
        d: ['M11.60 2.08L11.48 2.14L3.91 6.68C3.02 7.21 2.28 7.97 1.77 8.87C1.26 9.77 1.00 10.79 1 11.83V12.16L1.01 12.56C1.07 13.52 1.37 14.46 1.87 15.29C2.38 16.12 3.08 16.81 3.91 17.31L11.48 21.85C11.63 21.94 11.80 21.99 11.98 21.99C12.16 22.00 12.33 21.95 12.49 21.87C12.64 21.78 12.77 21.65 12.86 21.50C12.95 21.35 13 21.17 13 21V3C12.99 2.83 12.95 2.67 12.87 2.52C12.80 2.37 12.68 2.25 12.54 2.16C12.41 2.07 12.25 2.01 12.08 2.00C11.92 1.98 11.75 2.01 11.60 2.08ZM4.94 8.4V8.40L11 4.76V19.23L4.94 15.6C4.38 15.26 3.92 14.80 3.58 14.25C3.24 13.70 3.05 13.07 3.00 12.43L3 12.17V11.83C2.99 11.14 3.17 10.46 3.51 9.86C3.85 9.25 4.34 8.75 4.94 8.4ZM21.29 8.29L19 10.58L16.70 8.29L16.63 8.22C16.43 8.07 16.19 7.99 15.95 8.00C15.70 8.01 15.47 8.12 15.29 8.29C15.12 8.47 15.01 8.70 15.00 8.95C14.99 9.19 15.07 9.43 15.22 9.63L15.29 9.70L17.58 12L15.29 14.29C15.19 14.38 15.12 14.49 15.06 14.61C15.01 14.73 14.98 14.87 14.98 15.00C14.98 15.13 15.01 15.26 15.06 15.39C15.11 15.51 15.18 15.62 15.28 15.71C15.37 15.81 15.48 15.88 15.60 15.93C15.73 15.98 15.86 16.01 15.99 16.01C16.12 16.01 16.26 15.98 16.38 15.93C16.50 15.87 16.61 15.80 16.70 15.70L19 13.41L21.29 15.70L21.36 15.77C21.56 15.93 21.80 16.01 22.05 15.99C22.29 15.98 22.53 15.88 22.70 15.70C22.88 15.53 22.98 15.29 22.99 15.05C23.00 14.80 22.93 14.56 22.77 14.36L22.70 14.29L20.41 12L22.70 9.70C22.80 9.61 22.87 9.50 22.93 9.38C22.98 9.26 23.01 9.12 23.01 8.99C23.01 8.86 22.98 8.73 22.93 8.60C22.88 8.48 22.81 8.37 22.71 8.28C22.62 8.18 22.51 8.11 22.39 8.06C22.26 8.01 22.13 7.98 22.00 7.98C21.87 7.98 21.73 8.01 21.61 8.06C21.49 8.12 21.38 8.19 21.29 8.29Z'],
      },
      gear: {
        box: '0 0 24 24',
        d: ['M12.84 1H11.15C10.72 .99 10.30 1.14 9.95 1.40C9.60 1.66 9.35 2.02 9.23 2.44L9.19 2.61C9.11 3.00 8.96 3.38 8.73 3.71C8.51 4.04 8.22 4.33 7.89 4.55L7.75 4.64C7.37 4.85 6.96 4.98 6.53 5.02C6.11 5.06 5.68 5.01 5.27 4.87C4.86 4.73 4.42 4.73 4.00 4.86C3.59 5.00 3.23 5.26 2.99 5.62L2.89 5.77L2.05 7.23C1.82 7.63 1.73 8.10 1.81 8.55C1.88 9.01 2.12 9.43 2.47 9.73L2.58 9.84C3.15 10.39 3.50 11.15 3.50 12L3.49 12.16C3.47 12.56 3.37 12.95 3.19 13.31C3.01 13.67 2.77 13.99 2.47 14.26C2.12 14.56 1.88 14.98 1.81 15.43C1.73 15.89 1.82 16.36 2.05 16.76L2.89 18.22L2.99 18.37C3.24 18.73 3.59 18.99 4.01 19.13C4.42 19.26 4.86 19.26 5.27 19.12L5.42 19.07C5.81 18.96 6.21 18.93 6.61 18.98C7.01 19.03 7.40 19.15 7.75 19.36L7.89 19.44C8.22 19.66 8.51 19.95 8.73 20.28C8.96 20.61 9.11 20.99 9.19 21.38C9.28 21.84 9.52 22.24 9.88 22.54C10.24 22.83 10.69 23.00 11.15 23H12.84C13.30 23.00 13.75 22.83 14.11 22.54C14.47 22.24 14.71 21.84 14.80 21.38C14.89 20.96 15.06 20.56 15.31 20.21C15.55 19.86 15.88 19.57 16.25 19.36L16.39 19.28C16.75 19.10 17.14 18.99 17.54 18.96C17.94 18.94 18.34 18.99 18.72 19.12L18.89 19.17C19.31 19.27 19.75 19.24 20.15 19.07C20.55 18.90 20.88 18.60 21.10 18.23L21.95 16.76C22.18 16.36 22.26 15.89 22.19 15.43C22.11 14.98 21.88 14.56 21.53 14.26C21.23 13.99 20.98 13.67 20.80 13.31C20.63 12.95 20.52 12.56 20.50 12.16L20.50 12C20.50 11.57 20.59 11.14 20.77 10.75C20.94 10.36 21.20 10.01 21.53 9.73C21.88 9.43 22.11 9.01 22.19 8.55C22.26 8.10 22.18 7.63 21.95 7.23L21.10 5.76C20.88 5.39 20.55 5.09 20.15 4.92C19.76 4.75 19.31 4.72 18.89 4.82L18.72 4.87C18.34 5.00 17.94 5.05 17.54 5.03C17.14 5.00 16.75 4.89 16.4 4.71L16.25 4.63C15.88 4.42 15.56 4.13 15.31 3.78C15.06 3.43 14.89 3.03 14.80 2.61C14.71 2.15 14.47 1.74 14.11 1.45C13.75 1.16 13.30 .99 12.84 1ZM11.15 3H12.84C12.98 3.70 13.26 4.36 13.68 4.94C14.09 5.52 14.63 6.01 15.25 6.37C15.87 6.72 16.55 6.94 17.26 7.01C17.97 7.08 18.69 6.99 19.37 6.76L20.21 8.23C19.67 8.69 19.24 9.27 18.94 9.92C18.65 10.57 18.50 11.28 18.5 12C18.50 12.71 18.65 13.42 18.95 14.07C19.24 14.72 19.67 15.29 20.21 15.76L19.37 17.23C18.69 16.99 17.97 16.91 17.26 16.98C16.55 17.05 15.86 17.27 15.25 17.63C14.63 17.98 14.09 18.47 13.68 19.05C13.26 19.63 12.98 20.29 12.84 21H11.15C11.01 20.29 10.73 19.63 10.31 19.05C9.90 18.47 9.36 17.98 8.75 17.62C8.13 17.27 7.44 17.05 6.73 16.98C6.02 16.91 5.30 16.99 4.62 17.23L3.78 15.76C4.32 15.29 4.75 14.71 5.05 14.06C5.34 13.41 5.49 12.71 5.5 12C5.50 11.28 5.34 10.57 5.05 9.92C4.75 9.27 4.32 8.69 3.78 8.23L4.62 6.76C5.30 7.00 6.02 7.08 6.73 7.01C7.44 6.94 8.13 6.72 8.75 6.37C9.36 6.01 9.90 5.52 10.31 4.94C10.73 4.36 11.01 3.70 11.15 3ZM12.00 8C10.94 8 9.92 8.42 9.17 9.17C8.42 9.92 8.00 10.93 8.00 12C8.00 13.06 8.42 14.07 9.17 14.82C9.92 15.57 10.94 16 12.00 16C13.06 16 14.08 15.57 14.83 14.82C15.58 14.07 16.00 13.06 16.00 12C16.00 10.93 15.58 9.92 14.83 9.17C14.08 8.42 13.06 8 12.00 8ZM12.00 10H12L12.20 10.01C12.69 10.06 13.15 10.29 13.48 10.65C13.81 11.02 14.00 11.50 14 12L13.99 12.20C13.95 12.58 13.80 12.95 13.55 13.25C13.31 13.55 12.98 13.78 12.62 13.90C12.25 14.02 11.85 14.03 11.48 13.93C11.11 13.83 10.77 13.62 10.51 13.34C10.25 13.05 10.08 12.69 10.02 12.31C9.96 11.93 10.01 11.54 10.17 11.18C10.32 10.83 10.58 10.53 10.91 10.32C11.23 10.11 11.61 10.00 12 10'],
      },
      expand: {
        box: '0 0 24 24',
        d: ['M10 3H3V10C3 10.26 3.10 10.51 3.29 10.70C3.48 10.89 3.73 11 4 11C4.26 11 4.51 10.89 4.70 10.70C4.89 10.51 5 10.26 5 10V6.41L9.29 10.70L9.36 10.77C9.56 10.92 9.80 11.00 10.04 10.99C10.29 10.98 10.52 10.87 10.70 10.70C10.87 10.52 10.98 10.29 10.99 10.04C11.00 9.80 10.92 9.56 10.77 9.36L10.70 9.29L6.41 5H10C10.26 5 10.51 4.89 10.70 4.70C10.89 4.51 11 4.26 11 4C11 3.73 10.89 3.48 10.70 3.29C10.51 3.10 10.26 3 10 3ZM20 13C19.73 13 19.48 13.10 19.29 13.29C19.10 13.48 19 13.73 19 14V17.58L14.70 13.29L14.63 13.22C14.43 13.07 14.19 12.99 13.95 13.00C13.70 13.01 13.47 13.12 13.29 13.29C13.12 13.47 13.01 13.70 13.00 13.95C12.99 14.19 13.07 14.43 13.22 14.63L13.29 14.70L17.58 19H14C13.73 19 13.48 19.10 13.29 19.29C13.10 19.48 13 19.73 13 20C13 20.26 13.10 20.51 13.29 20.70C13.48 20.89 13.73 21 14 21H21V14C21 13.73 20.89 13.48 20.70 13.29C20.51 13.10 20.26 13 20 13Z'],
      },
      collapse: {
        box: '0 0 24 24',
        d: ['M3.29 3.29C3.11 3.46 3.01 3.70 3.00 3.94C2.98 4.19 3.06 4.43 3.22 4.63L3.29 4.70L7.58 8.99H5C4.73 8.99 4.48 9.10 4.29 9.29C4.10 9.47 4 9.73 4 9.99C4 10.26 4.10 10.51 4.29 10.70C4.48 10.89 4.73 10.99 5 10.99H11V4.99C11 4.73 10.89 4.47 10.70 4.29C10.51 4.10 10.26 3.99 10 3.99C9.73 3.99 9.48 4.10 9.29 4.29C9.10 4.47 9 4.73 9 4.99V7.58L4.70 3.29L4.63 3.22C4.43 3.06 4.19 2.98 3.94 3.00C3.70 3.01 3.46 3.11 3.29 3.29ZM19 13H13V19C13 19.26 13.10 19.51 13.29 19.70C13.48 19.89 13.73 20 14 20C14.26 20 14.51 19.89 14.70 19.70C14.89 19.51 15 19.26 15 19V16.41L19.29 20.70L19.36 20.77C19.56 20.92 19.80 21.00 20.04 20.99C20.29 20.98 20.52 20.87 20.70 20.70C20.87 20.52 20.98 20.29 20.99 20.04C21.00 19.80 20.92 19.56 20.77 19.36L20.70 19.29L16.41 15H19C19.26 15 19.51 14.89 19.70 14.70C19.89 14.51 20 14.26 20 14C20 13.73 19.89 13.48 19.70 13.29C19.51 13.10 19.26 13 19 13Z'],
      },
      // The settings menu's row icons, also YouTube's.
      quality: {
        box: '0 0 24 24',
        d: ['M9 3C8.11 2.99 7.25 3.29 6.54 3.83C5.84 4.38 5.34 5.14 5.12 6H3C2.73 6 2.48 6.10 2.29 6.29C2.10 6.48 2 6.73 2 7C2 7.26 2.10 7.51 2.29 7.70C2.48 7.89 2.73 8 3 8H5.12C5.34 8.85 5.84 9.61 6.55 10.16C7.25 10.70 8.11 10.99 9 10.99C9.88 10.99 10.74 10.70 11.44 10.16C12.15 9.61 12.65 8.85 12.87 8H21C21.26 8 21.51 7.89 21.70 7.70C21.89 7.51 22 7.26 22 7C22 6.73 21.89 6.48 21.70 6.29C21.51 6.10 21.26 6 21 6H12.87C12.65 5.14 12.15 4.38 11.45 3.83C10.74 3.29 9.88 2.99 9 3ZM9 5C9.53 5 10.03 5.21 10.41 5.58C10.78 5.96 11 6.46 11 7C11 7.53 10.78 8.03 10.41 8.41C10.03 8.78 9.53 9 9 9C8.46 9 7.96 8.78 7.58 8.41C7.21 8.03 7 7.53 7 7C7 6.46 7.21 5.96 7.58 5.58C7.96 5.21 8.46 5 9 5ZM15 13C14.11 12.99 13.25 13.29 12.54 13.83C11.84 14.38 11.34 15.14 11.12 16H3C2.73 16 2.48 16.10 2.29 16.29C2.10 16.48 2 16.73 2 17C2 17.26 2.10 17.51 2.29 17.70C2.48 17.89 2.73 18 3 18H11.12C11.34 18.85 11.84 19.61 12.55 20.16C13.25 20.70 14.11 20.99 15 20.99C15.88 20.99 16.74 20.70 17.44 20.16C18.15 19.61 18.65 18.85 18.87 18H21C21.26 18 21.51 17.89 21.70 17.70C21.89 17.51 22 17.26 22 17C22 16.73 21.89 16.48 21.70 16.29C21.51 16.10 21.26 16 21 16H18.87C18.65 15.14 18.15 14.38 17.45 13.83C16.74 13.29 15.88 12.99 15 13ZM15 15C15.53 15 16.03 15.21 16.41 15.58C16.78 15.96 17 16.46 17 17C17 17.53 16.78 18.03 16.41 18.41C16.03 18.78 15.53 19 15 19C14.46 19 13.96 18.78 13.58 18.41C13.21 18.03 13 17.53 13 17C13 16.46 13.21 15.96 13.58 15.58C13.96 15.21 14.46 15 15 15Z'],
      },
      speed: {
        box: '0 0 24 24',
        d: ['M12 1c1.44 0 2.87.28 4.21.83a11 11 0 0 1 3.45 2.27l-1.81 1.05A9 9 0 0 0 3 12a9 9 0 0 0 18-.00l-.01-.44a8.99 8.99 0 0 0-.14-1.20l1.81-1.05A11.00 11.00 0 0 1 10.51 22.9 11 11 0 0 1 12 1Zm7.08 6.25-7.96 3.25a1.74 1.74 0 1 0 1.73 2.99l6.8-5.26a.57.57 0 0 0-.56-.98Z'],
      },
      subtitles: {
        box: '0 0 24 24',
        d: ['M21.20 3.01L21 3H3L2.79 3.01C2.30 3.06 1.84 3.29 1.51 3.65C1.18 4.02 .99 4.50 1 5V19L1.01 19.20C1.05 19.66 1.26 20.08 1.58 20.41C1.91 20.73 2.33 20.94 2.79 20.99L3 21H21L21.20 20.98C21.66 20.94 22.08 20.73 22.41 20.41C22.73 20.08 22.94 19.66 22.99 19.20L23 19V5C23.00 4.50 22.81 4.02 22.48 3.65C22.15 3.29 21.69 3.06 21.20 3.01ZM3 19V5H21V19H3ZM8 11H6C5.73 11 5.48 11.10 5.29 11.29C5.10 11.48 5 11.73 5 12C5 12.26 5.10 12.51 5.29 12.70C5.48 12.89 5.73 13 6 13H8C8.26 13 8.51 12.89 8.70 12.70C8.89 12.51 9 12.26 9 12C9 11.73 8.89 11.48 8.70 11.29C8.51 11.10 8.26 11 8 11ZM18 11H12C11.73 11 11.48 11.10 11.29 11.29C11.10 11.48 11 11.73 11 12C11 12.26 11.10 12.51 11.29 12.70C11.48 12.89 11.73 13 12 13H18C18.26 13 18.51 12.89 18.70 12.70C18.89 12.51 19 12.26 19 12C19 11.73 18.89 11.48 18.70 11.29C18.51 11.10 18.26 11 18 11ZM18 15H16C15.73 15 15.48 15.10 15.29 15.29C15.10 15.48 15 15.73 15 16C15 16.26 15.10 16.51 15.29 16.70C15.48 16.89 15.73 17 16 17H18C18.26 17 18.51 16.89 18.70 16.70C18.89 16.51 19 16.26 19 16C19 15.73 18.89 15.48 18.70 15.29C18.51 15.10 18.26 15 18 15ZM12 15H6C5.73 15 5.48 15.10 5.29 15.29C5.10 15.48 5 15.73 5 16C5 16.26 5.10 16.51 5.29 16.70C5.48 16.89 5.73 17 6 17H12C12.26 17 12.51 16.89 12.70 16.70C12.89 16.51 13 16.26 13 16C13 15.73 12.89 15.48 12.70 15.29C12.51 15.10 12.26 15 12 15Z'],
      },
      theater: {
        box: '0 0 24 24',
        d: ['M21.20 3.01L21 3H3L2.79 3.01C2.30 3.06 1.84 3.29 1.51 3.65C1.18 4.02 .99 4.50 1 5V19L1.01 19.20C1.05 19.66 1.26 20.08 1.58 20.41C1.91 20.73 2.33 20.94 2.79 20.99L3 21H21L21.20 20.98C21.66 20.94 22.08 20.73 22.41 20.41C22.73 20.08 22.94 19.66 22.99 19.20L23 19V5C23.00 4.50 22.81 4.02 22.48 3.65C22.15 3.29 21.69 3.06 21.20 3.01ZM3 15V5H21V15H3ZM7.87 6.72L7.79 6.79L4.58 10L7.79 13.20C7.88 13.30 7.99 13.37 8.11 13.43C8.23 13.48 8.37 13.51 8.50 13.51C8.63 13.51 8.76 13.48 8.89 13.43C9.01 13.38 9.12 13.31 9.21 13.21C9.31 13.12 9.38 13.01 9.43 12.89C9.48 12.76 9.51 12.63 9.51 12.50C9.51 12.37 9.48 12.23 9.43 12.11C9.37 11.99 9.30 11.88 9.20 11.79L7.41 10L9.20 8.20L9.27 8.13C9.42 7.93 9.50 7.69 9.48 7.45C9.47 7.20 9.36 6.97 9.19 6.80C9.02 6.63 8.79 6.52 8.54 6.51C8.30 6.49 8.06 6.57 7.87 6.72ZM14.79 6.79C14.60 6.98 14.50 7.23 14.50 7.5C14.50 7.76 14.60 8.01 14.79 8.20L16.58 10L14.79 11.79L14.72 11.86C14.57 12.06 14.49 12.30 14.50 12.54C14.51 12.79 14.62 13.02 14.79 13.20C14.97 13.37 15.20 13.48 15.45 13.49C15.69 13.50 15.93 13.42 16.13 13.27L16.20 13.20L19.41 10L16.20 6.79C16.01 6.60 15.76 6.50 15.5 6.50C15.23 6.50 14.98 6.60 14.79 6.79ZM3 19V17H21V19H3Z'],
      },
      chapters: {
        box: '0 0 24 24',
        stroke: true,
        d: ['M3 6h18', 'M3 12h18', 'M3 18h18', 'M8 3v3', 'M14 9v3', 'M6 15v3'],
      },
      check: { box: '0 0 24 24', d: ['M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z'] },
      chevron: { box: '0 0 32 32', d: ['m12.59 20.34 4.58-4.59-4.58-4.59L14 9.75l6 6-6 6z'] },
      chevronLeft: { box: '0 0 32 32', d: ['m19.41 20.09-4.58-4.59 4.58-4.59L18 9.5l-6 6 6 6z'] },

      // ---------------------------------------------------- Lucide, for the gaps
      pip: {
        box: '0 0 24 24',
        stroke: true,
        d: [
          'M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4',
          'M10 14h10a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z',
        ],
      },
      replay: {
        box: '0 0 24 24',
        stroke: true,
        d: ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5'],
      },
      back: { box: '0 0 24 24', stroke: true, d: ['M11 19 2 12l9-7z', 'M22 19l-9-7 9-7z'] },
      forward: { box: '0 0 24 24', stroke: true, d: ['M13 19l9-7-9-7z', 'M2 19l9-7-9-7z'] },
      ambient: {
        box: '0 0 24 24',
        stroke: true,
        d: [
          'M12 3v1',
          'M12 20v1',
          'M3 12h1',
          'M20 12h1',
          'm5.6 5.6.7.7',
          'm17.7 17.7.7.7',
          'm5.6 18.4.7-.7',
          'm17.7 6.3.7-.7',
          'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
        ],
      },
      autoplay: {
        box: '0 0 24 24',
        stroke: true,
        d: ['M21 12a9 9 0 1 1-6.219-8.56', 'm10 9 5 3-5 3z'],
      },
      audio: {
        box: '0 0 24 24',
        stroke: true,
        d: ['M9 18V5l12-2v13', 'M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0z', 'M21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z'],
      },
      /**
       * The Argon Play mark: the same AP as icons/icon.svg, with the bars flattened to plain
       * quadrilaterals. At badge size the rounded corners are under a pixel wide, and a shape
       * per bar is cheaper than carrying the whole logo around.
       */
      argon: {
        box: '28 26 154 148',
        d: [
          { d: 'M59.6 38.3 81.3 42.1 58.7 170.1 37 166.3Z', opacity: 0.35 },
          { d: 'M91.5 88.4 95 108.1 65.5 113.3 62 93.6Z', opacity: 0.35 },
          'M85.7 41.5 107.3 37.7 129.9 165.7 108.2 169.5Z',
          'M157.3 30 160.7 49.7 113.5 58 110 38.3Z',
          'M165.4 74.2 168.9 93.9 121.6 102.3 118.1 82.6Z',
          'M157.7 28.8 177.4 32.2 166.3 95.2 146.6 91.8Z',
        ],
      },
      download: {
        box: '0 0 24 24',
        stroke: true,
        d: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5', 'M12 15V3'],
      },
    },

    send(message) {
      return new Promise((resolve) => {
        try {
          api.runtime.sendMessage(message, (response) => {
            const failure = api.runtime.lastError;
            resolve(failure ? { ok: false, error: failure.message } : response);
          });
        } catch (error) {
          resolve({ ok: false, error: String(error) });
        }
      });
    },

    async settings() {
      const response = await Argon.send({ type: 'settings' });
      return response?.ok ? response.data : null;
    },

    /**
     * What this browser will actually play. An instance lists every format the source has,
     * including AV1 at 4K that a laptop will accept and then drop every second frame of, so the
     * answer is the browser's own, not a table of assumptions.
     */
    playable(tracks) {
      const probe = document.createElement('video');

      return tracks
        .map((track) => ({ ...track, confidence: probe.canPlayType(track.contentType || track.mimeType || '') }))
        .filter((track) => track.confidence !== '');
    },

    pickVideo(tracks, { maxHeight = 1080, preferH264 = false } = {}) {
      const supported = Argon.playable(tracks);
      if (supported.length === 0) return null;

      const capped = supported.filter((track) => !track.height || track.height <= maxHeight);
      const pool = capped.length > 0 ? capped : supported;

      const rank = (track) => [
        track.height ?? 0,
        track.confidence === 'probably' ? 1 : 0,
        preferH264 ? (/avc1|h264/i.test(track.codec ?? '') ? 1 : 0) : 0,
        // At one resolution the smaller stream starts sooner and stutters less. VP9 is routinely
        // half of what H.264 costs for the same picture.
        preferH264 ? 0 : -(track.bytes ?? 0),
      ];

      return pool.sort((a, b) => {
        const left = rank(a);
        const right = rank(b);
        for (let i = 0; i < left.length; i++) {
          if (left[i] !== right[i]) return right[i] - left[i];
        }
        return 0;
      })[0];
    },

    pickAudio(tracks) {
      const supported = Argon.playable(tracks);
      if (supported.length === 0) return null;

      return supported.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
    },

    /** One entry per resolution for the quality menu, best first, unplayable ones dropped. */
    ladder(tracks, chosen) {
      const supported = Argon.playable(tracks);
      const byHeight = new Map();

      for (const track of supported) {
        const height = track.height ?? 0;
        const held = byHeight.get(height);

        if (!held || (track.bytes ?? Infinity) < (held.bytes ?? Infinity)) byHeight.set(height, track);
      }

      if (chosen) byHeight.set(chosen.height ?? 0, chosen);

      return [...byHeight.values()].sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
    },

    /**
     * YouTube packs its hover thumbnails into sprite sheets and describes them in one string:
     *
     *   baseUrl|W#H#count#cols#rows#interval#name#sigh|W#H#...
     *
     * The base carries `$L` for the level and `$N` for the sheet's name, and the name itself
     * carries `$M` for the sheet number. Given a time, the frame is a cell in one of those
     * sheets, so what comes back is a URL plus where to offset it by.
     */
    storyboard(spec) {
      if (typeof spec !== 'string' || !spec.includes('|')) return null;

      const [base, ...levels] = spec.split('|');

      const parsed = levels
        // The position matters - it is the $L in the URL - and the spec ends with a stray field
        // that is not a level at all, so the index has to be carried rather than counted later.
        .map((level, index) => {
          const [width, height, , columns, rows, interval, name, sigh] = level.split('#');

          return {
            index,
            width: Number(width),
            height: Number(height),
            columns: Number(columns),
            rows: Number(rows),
            interval: Number(interval),
            name: name ?? '',
            sigh: sigh ?? '',
          };
        })
        // Level 0 has no interval and is the tiny one; the biggest usable level looks best.
        .filter((level) => level.interval > 0 && level.columns > 0 && level.rows > 0
          && level.width > 0 && level.height > 0);

      if (parsed.length === 0) return null;

      const level = parsed[parsed.length - 1];
      const index = level.index;
      const perSheet = level.columns * level.rows;

      return {
        width: level.width,
        height: level.height,
        columns: level.columns,
        at(seconds) {
          const frame = Math.max(0, Math.floor((seconds * 1000) / level.interval));
          const sheet = Math.floor(frame / perSheet);
          const cell = frame % perSheet;

          const url = base
            .replace('$L', String(index))
            .replace('$N', level.name.replace('$M', String(sheet)))
            + `&sigh=${level.sigh}`;

          return {
            url,
            x: -(cell % level.columns) * level.width,
            y: -Math.floor(cell / level.columns) * level.height,
          };
        },
      };
    },

    time(seconds) {
      if (!Number.isFinite(seconds) || seconds < 0) return '0:00';

      const whole = Math.floor(seconds);
      const hours = Math.floor(whole / 3600);
      const minutes = Math.floor((whole % 3600) / 60);
      const rest = whole % 60;

      return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
        : `${minutes}:${String(rest).padStart(2, '0')}`;
    },

    size(bytes) {
      if (!bytes) return null;

      const units = ['B', 'KB', 'MB', 'GB'];
      let value = bytes;
      let unit = 0;

      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
      }

      return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
    },

    log(...args) {
      console.debug('%cArgon Play', 'color:#b07cf0;font-weight:600', ...args);
    },
  };

  globalThis.Argon = Argon;
})();
