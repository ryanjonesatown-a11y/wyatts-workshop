// ---------------------------------------------------------------------------
// THE PARTS LIST
// Every tile we own lives here. To fix a size or a count, change the number
// on that tile's line and reload the page. Nothing else needs editing.
//
// All sizes are in INCHES and are APPROXIMATE until measured.
//
// Shapes:
//   square         size            (edge length)
//   triangle       base, height    (point is centred above the base)
//   rightTriangle  a, b            (the two edges that make the square corner)
//   quarter        radius          (quarter circle; the two straight edges)
//   polygon        points          (list of [x, y] corners, anticlockwise)
//                  magnetEdges     (which edges have magnets; edge 0 runs
//                                   from point 0 to point 1, and so on)
// ---------------------------------------------------------------------------

export const UNIT_INCHES = 3;        // one "small square" edge
export const THICKNESS_INCHES = 0.22;

export const TILES = [
  { id: 'tri-orange-a',   name: 'Small triangle',        color: '#ff8a1f', count: 15, shape: 'triangle', base: 3, height: 2.6 },
  { id: 'tri-brick',      name: 'Tower triangle',        color: '#ffd21f', count: 12, shape: 'triangle', base: 3, height: 5.8 },
  { id: 'sq-red',         name: 'Red square',            color: '#e3262e', count: 3,  shape: 'square', size: 3 },
  { id: 'sq-purple',      name: 'Purple square',         color: '#7a2fd0', count: 27, shape: 'square', size: 3 },
  { id: 'sq-red-big',     name: 'Big red square',        color: '#f0314a', count: 4,  shape: 'square', size: 6 },
  { id: 'quarter-purple', name: 'Quarter circle',        color: '#8f6be8', count: 4,  shape: 'quarter', radius: 3 },
  { id: 'tri-orange-b',   name: 'Triangle',              color: '#ff9a2e', count: 21, shape: 'triangle', base: 3, height: 2.6 },
  { id: 'sq-pink',        name: 'Pink square',           color: '#f0329a', count: 31, shape: 'square', size: 3 },
  { id: 'rtri-pink',      name: 'Long corner triangle',  color: '#f43fa5', count: 6,  shape: 'rightTriangle', a: 3, b: 6 },
  { id: 'rtri-blue',      name: 'Corner triangle',       color: '#1f3fd6', count: 11, shape: 'rightTriangle', a: 3, b: 3 },
  { id: 'tree-green',     name: 'Pine tree',             color: '#22c04a', count: 5,  shape: 'polygon',
    points: [[0, 0], [2.75, 0], [1.5, 0.9], [2.7, 1.15], [1.45, 2.0], [1.8, 2.15], [0, 3]],
    magnetEdges: [6] },
  { id: 'tri-teal',       name: 'Tall triangle',         color: '#12a9d6', count: 6,  shape: 'triangle', base: 3, height: 4.5 },
];
