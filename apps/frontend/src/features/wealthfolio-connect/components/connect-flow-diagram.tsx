import appLogo from "@/assets/logo-rounded.png";
import { useTranslation } from "react-i18next";

export function ConnectFlowDiagram() {
  const { t } = useTranslation();
  return (
    <div className="bg-card border-border rounded-2xl border border-dashed p-4 sm:p-5">
      <svg viewBox="0 -8 730 175" className="h-auto w-full" xmlns="http://www.w3.org/2000/svg">
        {/* ========== YOUR DEVICE (Left) ========== */}
        <g transform="translate(20, 40)">
          {/* Card background */}
          <rect
            x="0"
            y="0"
            width="180"
            height="70"
            rx="16"
            className="fill-white stroke-[#e8e4dc] dark:fill-white/5 dark:stroke-white/10"
            strokeWidth="1"
          />
          {/* Logo */}
          <image
            href={appLogo}
            x="16"
            y="15"
            width="40"
            height="40"
            preserveAspectRatio="xMidYMid slice"
          />
          {/* Text */}
          <text
            x="68"
            y="32"
            className="fill-[#3d3d3d] dark:fill-white/90"
            fontSize="14"
            fontWeight="500"
          >
            {t("connect:flow.yourDevice")}
          </text>
          <text x="68" y="50" className="fill-[#9a9a9a] dark:fill-white/50" fontSize="12">
            {t("connect:flow.localDatabase")}
          </text>

          {/* Labels below */}
          <text
            x="90"
            y="100"
            textAnchor="middle"
            className="fill-[#504f4f] dark:fill-white/50"
            fontSize="12"
          >
            Wealthfolio
          </text>
          <text
            x="90"
            y="116"
            textAnchor="middle"
            className="fill-[#b5b0a6] dark:fill-white/30"
            fontSize="10"
          >
            {t("connect:flow.dataStaysHere")}
          </text>
        </g>

        {/* ========== CONNECTOR: Device to Connect ========== */}
        <g transform="translate(200, 75)">
          {/* Dashed line */}
          <path
            d="M 0 0 L 70 0"
            fill="none"
            strokeWidth="1.5"
            strokeDasharray="5 5"
            className="stroke-[#c5c0b6] dark:stroke-white/20"
          />
          {/* Arrow */}
          <polygon points="8,-5 8,5 0,0" className="fill-[#c5c0b6] dark:fill-white/30" />
          {/* Animated dot */}
          <circle r="4" className="fill-[#8b7355] dark:fill-[#a69580]">
            <animateMotion dur="2.5s" repeatCount="indefinite" path="M 70 0 L 0 0" />
          </circle>
        </g>

        {/* ========== CONNECT HUB (Center) ========== */}
        <g transform="translate(270, 43)">
          {/* Spinning logo */}
          <g transform="translate(32, 32)">
            <image
              href={appLogo}
              x="-32"
              y="-32"
              width="64"
              height="64"
              preserveAspectRatio="xMidYMid slice"
            >
              <animateTransform
                attributeName="transform"
                type="rotate"
                from="360 0 0"
                to="0 0 0"
                dur="20s"
                repeatCount="indefinite"
              />
            </image>
          </g>
          {/* Label below */}
          <text
            x="32"
            y="100"
            textAnchor="middle"
            className="fill-[#5a5347] dark:fill-white/70"
            fontSize="14"
            fontWeight="700"
          >
            Connect
          </text>
        </g>

        {/* ========== CONNECTOR: Connect to Aggregators ========== */}
        <g transform="translate(334, 75)">
          {/* Dashed line */}
          <path
            d="M 0 0 L 70 0"
            fill="none"
            strokeWidth="1.5"
            strokeDasharray="5 5"
            className="stroke-[#c5c0b6] dark:stroke-white/20"
          />
          {/* Animated dot */}
          <circle r="4" className="fill-[#8b7355] dark:fill-[#a69580]">
            <animateMotion dur="2.5s" repeatCount="indefinite" begin="0.5s" path="M 70 0 L 0 0" />
          </circle>
        </g>

        {/* ========== AGGREGATORS ========== */}
        <g transform="translate(404, 47)">
          {/* Card background */}
          <rect
            x="0"
            y="0"
            width="56"
            height="56"
            rx="16"
            className="fill-white stroke-[#e8e4dc] dark:fill-white/5 dark:stroke-white/10"
            strokeWidth="1"
          />
          {/* Arrows icon (data sync) */}
          <g transform="translate(12, 12) scale(0.125)">
            <path
              d="M224,48V208a16,16,0,0,1-16,16H48a16,16,0,0,1-16-16V48A16,16,0,0,1,48,32H208A16,16,0,0,1,224,48Z"
              className="fill-[#f5f3ed] dark:fill-white/10"
            />
            <path
              d="M90.34,69.66a8,8,0,0,1,11.32-11.32L120,76.69V24a8,8,0,0,1,16,0V76.69l18.34-18.35a8,8,0,0,1,11.32,11.32l-32,32a8,8,0,0,1-11.32,0Zm43.32,84.68a8,8,0,0,0-11.32,0l-32,32a8,8,0,0,0,11.32,11.32L120,179.31V232a8,8,0,0,0,16,0V179.31l18.34,18.35a8,8,0,0,0,11.32-11.32ZM232,120H179.31l18.35-18.34a8,8,0,0,0-11.32-11.32l-32,32a8,8,0,0,0,0,11.32l32,32a8,8,0,0,0,11.32-11.32L179.31,136H232a8,8,0,0,0,0-16Zm-130.34,2.34-32-32a8,8,0,0,0-11.32,11.32L76.69,120H24a8,8,0,0,0,0,16H76.69L58.34,154.34a8,8,0,0,0,11.32,11.32l32-32A8,8,0,0,0,101.66,122.34Z"
              className="fill-[#9a9a9a] dark:fill-white/50"
            />
          </g>
          {/* Labels below */}
          <text
            x="28"
            y="88"
            textAnchor="middle"
            className="fill-[#504f4f] dark:fill-white/50"
            fontSize="12"
          >
            {t("connect:flow.aggregators")}
          </text>
          <text
            x="28"
            y="104"
            textAnchor="middle"
            className="fill-[#b5b0a6] dark:fill-white/30"
            fontSize="10"
          >
            (e.g. SnapTrade)
          </text>
        </g>

        {/* ========== CONNECTOR: Aggregators to Sources (branching) ========== */}
        <g transform="translate(460, 75)">
          {/* Top curve to Brokerages (y=-58) */}
          <path
            id="path-to-brokerages"
            d="M 0 0 C 40 0, 55 -58, 95 -58"
            fill="none"
            strokeWidth="1.5"
            strokeDasharray="5 5"
            className="stroke-[#c5c0b6] dark:stroke-white/20"
          />
          {/* Middle line to Banks (y=0, aligned with Aggregators) */}
          <path
            id="path-to-banks"
            d="M 0 0 L 95 0"
            fill="none"
            strokeWidth="1.5"
            strokeDasharray="5 5"
            className="stroke-[#c5c0b6] dark:stroke-white/20"
          />
          {/* Bottom curve to Crypto (y=+58) */}
          <path
            id="path-to-crypto"
            d="M 0 0 C 40 0, 55 58, 95 58"
            fill="none"
            strokeWidth="1.5"
            strokeDasharray="5 5"
            className="stroke-[#c5c0b6] dark:stroke-white/20"
          />
          {/* Animated dots - using same paths reversed */}
          <circle r="4" className="fill-[#8b7355] dark:fill-[#a69580]">
            <animateMotion
              dur="3s"
              repeatCount="indefinite"
              begin="0s"
              path="M 95 -58 C 55 -58, 40 0, 0 0"
            />
          </circle>
          <circle r="4" className="fill-[#8b7355] dark:fill-[#a69580]">
            <animateMotion dur="3s" repeatCount="indefinite" begin="0.4s" path="M 95 0 L 0 0" />
          </circle>
          <circle r="4" className="fill-[#8b7355] dark:fill-[#a69580]">
            <animateMotion
              dur="3s"
              repeatCount="indefinite"
              begin="0.8s"
              path="M 95 58 C 55 58, 40 0, 0 0"
            />
          </circle>
        </g>

        {/* ========== SOURCE ITEMS (Right) ========== */}
        {/* Brokerages (center at y=17, symmetric -58 from y=75) */}
        <g transform="translate(555, -8)">
          <rect
            x="0"
            y="0"
            width="150"
            height="50"
            rx="16"
            className="fill-white stroke-[#e8e4dc] dark:fill-white/5 dark:stroke-white/10"
            strokeWidth="1"
          />
          {/* Icon background */}
          <rect
            x="12"
            y="9"
            width="32"
            height="32"
            rx="10"
            className="fill-[#f5f3ed] dark:fill-white/10"
          />
          {/* Landmark icon (bank building) */}
          <g transform="translate(19, 15)">
            <path
              d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v3M12 14v3M16 14v3"
              fill="none"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="stroke-[#9a9a9a] dark:stroke-white/50"
              transform="scale(0.8)"
            />
          </g>
          <text
            x="56"
            y="30"
            className="fill-[#3d3d3d] dark:fill-white/80"
            fontSize="13"
            fontWeight="500"
          >
            {t("connect:flow.brokerages")}
          </text>
        </g>

        {/* Banks (y=50, center at y=75, aligned with Aggregators) */}
        <g transform="translate(555, 50)">
          <rect
            x="0"
            y="0"
            width="150"
            height="50"
            rx="16"
            className="fill-white stroke-[#e8e4dc] dark:fill-white/5 dark:stroke-white/10"
            strokeWidth="1"
          />
          {/* Icon background */}
          <rect
            x="12"
            y="9"
            width="32"
            height="32"
            rx="10"
            className="fill-[#f5f3ed] dark:fill-white/10"
          />
          {/* Building icon */}
          <g transform="translate(19, 15)">
            <path
              d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18ZM6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2M10 6h4M10 10h4M10 14h4M10 18h4"
              fill="none"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="stroke-[#9a9a9a] dark:stroke-white/50"
              transform="scale(0.75)"
            />
          </g>
          <text
            x="56"
            y="30"
            className="fill-[#3d3d3d] dark:fill-white/80"
            fontSize="13"
            fontWeight="500"
          >
            {t("connect:flow.banks")}
          </text>
        </g>

        {/* Crypto (y=108, center at y=133, symmetric +58 from y=75) */}
        <g transform="translate(555, 108)">
          <rect
            x="0"
            y="0"
            width="150"
            height="50"
            rx="16"
            className="fill-white stroke-[#e8e4dc] dark:fill-white/5 dark:stroke-white/10"
            strokeWidth="1"
          />
          {/* Icon background */}
          <rect
            x="12"
            y="9"
            width="32"
            height="32"
            rx="10"
            className="fill-[#f5f3ed] dark:fill-white/10"
          />
          {/* Bitcoin icon */}
          <g transform="translate(21, 16)">
            <path
              d="M11.767 19.089c4.924.868 6.14-6.025 1.216-6.894m-1.216 6.894L5.86 18.047m5.908 1.042-.347 1.97m1.563-8.864c4.924.869 6.14-6.025 1.215-6.893m-1.215 6.893-3.94-.694m5.155-6.2L8.29 4.26m5.908 1.042.348-1.97M7.48 20.364l3.126-17.727"
              fill="none"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="stroke-[#9a9a9a] dark:stroke-white/50"
              transform="scale(0.7)"
            />
          </g>
          <text
            x="56"
            y="30"
            className="fill-[#3d3d3d] dark:fill-white/80"
            fontSize="13"
            fontWeight="500"
          >
            {t("connect:flow.crypto")}
          </text>
        </g>

        {/* Connection dots at line endpoints (y=17, 75, 133) */}
        <circle cx="555" cy="17" r="4" className="fill-[#c5c0b6] dark:fill-white/30" />
        <circle cx="555" cy="75" r="4" className="fill-[#c5c0b6] dark:fill-white/30" />
        <circle cx="555" cy="133" r="4" className="fill-[#c5c0b6] dark:fill-white/30" />
      </svg>
    </div>
  );
}
