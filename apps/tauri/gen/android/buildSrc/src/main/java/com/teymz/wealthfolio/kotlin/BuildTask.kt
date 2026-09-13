import java.io.File
import org.apache.tools.ant.taskdefs.condition.Os
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.logging.LogLevel
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction

open class BuildTask : DefaultTask() {
    @Input
    var rootDirRel: String? = null
    @Input
    var target: String? = null
    @Input
    var release: Boolean? = null

    private fun projectProperty(name: String): String? =
        project.findProperty(name)?.toString()?.takeIf { it.isNotBlank() }

    private fun androidSdkHome(): File {
        val sdkHome = System.getenv("ANDROID_HOME")
            ?: System.getenv("ANDROID_SDK_ROOT")
            ?: throw GradleException("ANDROID_HOME or ANDROID_SDK_ROOT must be set")

        return File(sdkHome)
    }

    private fun androidNdkHome(): File {
        val configuredVersion = projectProperty("wealthfolioAndroidNdkVersion")
        if (configuredVersion != null) {
            val configuredNdk = File(androidSdkHome(), "ndk/$configuredVersion")
            if (configuredNdk.isDirectory) {
                return configuredNdk
            }
        }

        val ndkHome = System.getenv("ANDROID_NDK_HOME")
            ?: System.getenv("NDK_HOME")
            ?: throw GradleException("Android NDK $configuredVersion is not installed and no NDK_HOME is set")

        return File(ndkHome)
    }

    private fun androidPrebuiltHost(): String = when {
        Os.isFamily(Os.FAMILY_MAC) -> "darwin-x86_64"
        Os.isFamily(Os.FAMILY_WINDOWS) -> "windows-x86_64"
        else -> "linux-x86_64"
    }

    private fun androidMinSdk(): String = projectProperty("wealthfolioAndroidMinSdk") ?: "24"

    private fun androidLinker(target: String): Pair<String, File>? {
        val api = androidMinSdk()
        val executableSuffix = if (Os.isFamily(Os.FAMILY_WINDOWS)) ".cmd" else ""
        val (envName, executable) = when (target) {
            "aarch64" -> "CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER" to "aarch64-linux-android${api}-clang"
            "armv7" -> "CARGO_TARGET_ARMV7_LINUX_ANDROIDEABI_LINKER" to "armv7a-linux-androideabi${api}-clang"
            "i686" -> "CARGO_TARGET_I686_LINUX_ANDROID_LINKER" to "i686-linux-android${api}-clang"
            "x86_64" -> "CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER" to "x86_64-linux-android${api}-clang"
            else -> return null
        }

        val linker = File(
            androidNdkHome(),
            "toolchains/llvm/prebuilt/${androidPrebuiltHost()}/bin/$executable$executableSuffix"
        )

        if (!linker.isFile) {
            throw GradleException("Android Rust linker not found: ${linker.absolutePath}")
        }

        return envName to linker
    }

    @TaskAction
    fun assemble() {
        val executable = """pnpm""";
        try {
            runTauriCli(executable)
        } catch (e: Exception) {
            if (Os.isFamily(Os.FAMILY_WINDOWS)) {
                // Try different Windows-specific extensions
                val fallbacks = listOf(
                    "$executable.exe",
                    "$executable.cmd",
                    "$executable.bat",
                )

                var lastException: Exception = e
                for (fallback in fallbacks) {
                    try {
                        runTauriCli(fallback)
                        return
                    } catch (fallbackException: Exception) {
                        lastException = fallbackException
                    }
                }
                throw lastException
            } else {
                throw e;
            }
        }
    }

    fun runTauriCli(executable: String) {
        val rootDirRel = rootDirRel ?: throw GradleException("rootDirRel cannot be null")
        val target = target ?: throw GradleException("target cannot be null")
        val release = release ?: throw GradleException("release cannot be null")
        val args = listOf("tauri", "android", "android-studio-script");

        project.exec {
            workingDir(File(project.projectDir, rootDirRel))
            executable(executable)
            args(args)
            if (project.logger.isEnabled(LogLevel.DEBUG)) {
                args("-vv")
            } else if (project.logger.isEnabled(LogLevel.INFO)) {
                args("-v")
            }
            if (release) {
                args("--release")
            }
            androidLinker(target)?.let { (envName, linker) ->
                environment(envName, linker.absolutePath)
            }
            args(listOf("--target", target))
        }.assertNormalExitValue()
    }
}
