let size = 0;
function init() {
  size += 5;
}
init();

let depth = 0;
function bump() {
  depth++;
}
bump();

const box = { width: 1 };
[1].forEach(() => {
  box.width = 7;
});

export const padding = `${size}px`;
export const zIndex = depth;
export const width = `${box.width}px`;
