import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { listenNavigateToRoute } from "@/adapters";
import {
  clearAddonNavigationHandler,
  setAddonNavigationHandler,
} from "@/addons/addons-runtime-context";

const useNavigationEventListener = () => {
  const navigate = useNavigate();

  useEffect(() => {
    let cleanup = () => {
      return;
    };

    setAddonNavigationHandler(navigate);

    const setupNavigationListener = async () => {
      const handleNavigateToRoute = (event: { payload: { route: string } }) => {
        const { route } = event.payload;
        navigate(route);
      };

      const unlisten = await listenNavigateToRoute(handleNavigateToRoute);
      return unlisten;
    };

    setupNavigationListener()
      .then((unlistenFn) => {
        cleanup = unlistenFn;
      })
      .catch((error) => {
        console.error("Failed to setup navigation event listener:", error);
      });

    return () => {
      clearAddonNavigationHandler(navigate);
      cleanup();
    };
  }, [navigate]);

  return null;
};

export default useNavigationEventListener;
