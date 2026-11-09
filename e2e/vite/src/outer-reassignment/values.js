let size = 0;
function init() {
  size = 5;
}
init();

let depth = 0;
class Layer {
  constructor() {
    depth = 2;
  }
}
new Layer();

export const padding = size;
export const zIndex = depth;
