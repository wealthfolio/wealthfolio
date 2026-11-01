package com.teymz.wealthfolio

import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

// Only the app's own pages; addon frames have an opaque origin.
private val APP_ORIGINS = setOf("http://tauri.localhost", "https://tauri.localhost")

class MainActivity : TauriActivity() {
  // The navigation bar's height (gesture handle or buttons), in CSS pixels.
  private var navigationBarInset = 0f
  // Where to send it: the page that last asked for it.
  private var insetReply: JavaScriptReplyProxy? = null
  // Whether the app's theme is light, as the page last reported it.
  private var lightAppearance: Boolean? = null

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    // Edge-to-edge draws the page under the navigation bar, yet the WebView (133 here)
    // reports no bottom safe area for it. Send the page the bar's height, so it can pad
    // its bottom edges. Read the insets after layout rather than with an insets
    // listener: that would replace the WebView's own, which gives the page its top
    // safe area.
    webView.viewTreeObserver.addOnGlobalLayoutListener {
      val insets = ViewCompat.getRootWindowInsets(webView) ?: return@addOnGlobalLayoutListener
      val inset =
        insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom /
          resources.displayMetrics.density
      if (inset != navigationBarInset) {
        navigationBarInset = inset
        insetReply?.postMessage(inset.toString())
      }
    }
    if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
      // The page asks for the inset, and reports its theme so the system bar icons
      // stay readable over its colours: it can differ from Android's light or dark.
      WebViewCompat.addWebMessageListener(webView, "WealthfolioAndroid", APP_ORIGINS) {
        _, message, _, isMainFrame, replyProxy ->
        if (!isMainFrame) return@addWebMessageListener
        when (message.data) {
          "insets" -> {
            insetReply = replyProxy
            replyProxy.postMessage(navigationBarInset.toString())
          }
          "appearance:light" -> applyAppearance(true)
          "appearance:dark" -> applyAppearance(false)
        }
      }
    }
    // The WebView would enlarge text by Android's font size on its own, leaving
    // icons, spacing and controls at their size, and the app's Text size setting
    // would then multiply it. Hand the app the scale instead: until a size is
    // picked, it starts at the one nearest to Android's (src/themes/text-size.ts).
    webView.settings.textZoom = 100
    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
      val scale = resources.configuration.fontScale
      WebViewCompat.addDocumentStartJavaScript(
        webView,
        "window.wealthfolioSystemTextScale = $scale;",
        APP_ORIGINS,
      )
    }
  }

  private fun applyAppearance(light: Boolean) {
    lightAppearance = light
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = light
      isAppearanceLightNavigationBars = light
    }
  }

  // Edge-to-edge, with no scrim behind the navigation buttons: the app's tab bar runs
  // under them in its own colour, as Material apps do. Icons follow the app's theme
  // once the page has reported it, else Android's.
  private fun applyEdgeToEdge() {
    enableEdgeToEdge()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      window.isNavigationBarContrastEnforced = false
    }
    lightAppearance?.let { applyAppearance(it) }
  }

  override fun onPause() {
    window.addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
    super.onPause()
  }

  override fun onResume() {
    super.onResume()
    window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    applyEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    // The manifest handles uiMode changes without recreating the activity, so
    // re-apply edge-to-edge to give the system bar icons the new light/dark mode.
    applyEdgeToEdge()
  }
}
