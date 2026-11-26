export default function AwraButton({
  variant = "secondary",
  className = "",
  type = "button",
  ...props
}) {
  const base =
    "w-full rounded-md px-5 py-3 font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-50";
  const variantClass =
    variant === "primary"
      ? "bg-white text-black hover:bg-white/85"
      : "border border-white text-white hover:bg-white hover:text-black";

  return <button type={type} className={`${base} ${variantClass} ${className}`} {...props} />;
}
