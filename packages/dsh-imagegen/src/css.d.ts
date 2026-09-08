declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}

declare module "*.css" {
  const css: string & Record<string, string>;
  export default css;
}
