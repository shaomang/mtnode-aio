/**
 * dsh-super-injector — 超级模组注入器 + 热重载引擎（融合 dsh-bundle-hmr）。
 *
 * DSH 生态的 BepInEx：运行时注入任意本地插件包 + 整包热重载 + 插件状态，
 * 不碰 patch/package.json（注入路径）或改 profile 双路径装配（install 路径）。
 *
 * 能力：
 *  1. dev_inject_plugin     — 运行时注入本地插件包（junction + loader.create，免持久化）
 *  2. dev_install_package   — 双路径热装配（profile package.json + junction + loader.create，重启后由 bundles 接管）
 *  3. dev_reload_package    — 确定性整包热重载（清缓存 → import → registry 重建 fiber，失败回滚）
 *  4. dev_plugin_status     — 已装配插件清单（id/name/fiber 状态/入口）
 *  5. dev_injected_list     — 注入清单（registry.json，重启自动恢复）
 *  6. 自动轮询 watch        — lib 产物指纹变化 → 自动热重载
 *  7. 静态能力提示注入       — 固定文本 + order 靠前（静态到头：工具 schema
 *     变更时静态段仍缓存命中；动态内容才走尾部/消息尾）
 *
 * 关键机制（全部实测验证）：
 *  - loadCache key 是 realpath URL（file:///F:/...，匹配用目录名子串）；
 *  - ctx.registry 是 accessor，完整 ctx 可用；重建 fiber 用 entry.options.config
 *    （避免覆盖 include.refresh 热更新的配置）；
 *  - 官方 HMR 对 bundle 插件不生效（node_modules 排除 + root:[]），本插件补上。
 */
import { Context } from 'cordis';
import type Loader from '@deepseek-ai/cordis-plugin-loader';
import type SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import type ToolRegistry from '@deepseek-ai/dsh-tools';
type AppContext = Context & {
    loader: Loader;
    tools: ToolRegistry;
    systemPrompt: SystemPrompt;
    webServer: any;
    registry: any;
    setInterval(fn: () => void, ms: number): any;
};
export declare const name = "dsh-super-injector";
export declare const inject: string[];
export interface Config {
    /** 注入清单文件路径（缺省 ~/.dsh/super-injector/registry.json）。 */
    registryFile: string;
    /** junction 链接目标目录（缺省 ~/.dsh/profiles/web/node_modules）。 */
    profileNodeModules: string;
    /** 启动时自动恢复清单中的注入。 */
    autoRestore: boolean;
    /** 轮询间隔（ms）。构建产物整批写入，间隔轮询天然合并抖动。 */
    intervalMs: number;
    /** 监听目录 → 缓存匹配子串（loadCache key 是 realpath，用目录名匹配）。 */
    watches: Array<{
        dir: string;
        match: string;
    }>;
}
export declare const Config: Config;
export declare function apply(ctx: AppContext, config: Config): void;
export {};
