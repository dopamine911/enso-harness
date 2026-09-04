// TS7 checks SIDE-EFFECT imports (TS2882) where 5.x silently allowed an unresolved
// `import "./styles/global.css"`. The css is bun's to bundle (the dev server injects it);
// this ambient declaration tells the typechecker the module shape exists — nothing more.
declare module "*.css";
