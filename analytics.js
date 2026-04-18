/**
 * 求职面试助手 - 数据分析埋点 SDK
 * 支持：UV/PV、页面停留时间、滚动行为、用户行为漏斗
 */

(function () {
  'use strict';

  // ==================== 配置 ====================
  const CONFIG = {
    // 数据存储键名前缀
    STORAGE_PREFIX: 'jia_analytics_',
    // 会话超时时间（30分钟）
    SESSION_TIMEOUT: 30 * 60 * 1000,
    // 心跳上报间隔（30秒）
    HEARTBEAT_INTERVAL: 30 * 1000,
    // 滚动深度记录阈值
    SCROLL_DEPTH_LEVELS: [25, 50, 75, 90, 100],
  };

  // ==================== 工具函数 ====================
  const utils = {
    // 生成唯一ID
    generateId: () => {
      return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
    },

    // 获取或创建用户ID
    getUserId: () => {
      let userId = localStorage.getItem(CONFIG.STORAGE_PREFIX + 'user_id');
      if (!userId) {
        userId = utils.generateId();
        localStorage.setItem(CONFIG.STORAGE_PREFIX + 'user_id', userId);
      }
      return userId;
    },

    // 获取或创建会话ID
    getSessionId: () => {
      const sessionKey = CONFIG.STORAGE_PREFIX + 'session';
      let session = JSON.parse(sessionStorage.getItem(sessionKey) || 'null');
      const now = Date.now();

      if (!session || (now - session.lastActive) > CONFIG.SESSION_TIMEOUT) {
        session = {
          id: utils.generateId(),
          startTime: now,
          lastActive: now,
          visitCount: 0,
        };
      }
      session.lastActive = now;
      session.visitCount++;
      sessionStorage.setItem(sessionKey, JSON.stringify(session));
      return session;
    },

    // 获取页面名称
    getPageName: () => {
      const path = window.location.pathname;
      const pageMap = {
        '/index.html': '首页',
        '/resume.html': '简历诊断',
        '/jobs.html': '岗位推荐',
        '/gap.html': '能力差距',
        '/interview.html': '模拟面试',
      };
      return pageMap[path] || path;
    },

    // 获取设备信息
    getDeviceInfo: () => {
      return {
        userAgent: navigator.userAgent,
        screenWidth: window.screen.width,
        screenHeight: window.screen.height,
        language: navigator.language,
        referrer: document.referrer || '',
      };
    },

    // 防抖函数
    debounce: (fn, delay) => {
      let timer = null;
      return function (...args) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
      };
    },

    // 节流函数
    throttle: (fn, interval) => {
      let lastTime = 0;
      return function (...args) {
        const now = Date.now();
        if (now - lastTime >= interval) {
          lastTime = now;
          fn.apply(this, args);
        }
      };
    },
  };

  // ==================== 数据存储 ====================
  const storage = {
    // 存储事件
    saveEvent: (event) => {
      const key = CONFIG.STORAGE_PREFIX + 'events';
      const events = JSON.parse(localStorage.getItem(key) || '[]');
      events.push({
        ...event,
        timestamp: Date.now(),
      });
      // 最多保留1000条
      if (events.length > 1000) {
        events.splice(0, events.length - 1000);
      }
      localStorage.setItem(key, JSON.stringify(events));
    },

    // 获取所有事件
    getEvents: () => {
      const key = CONFIG.STORAGE_PREFIX + 'events';
      return JSON.parse(localStorage.getItem(key) || '[]');
    },

    // 清空事件
    clearEvents: () => {
      localStorage.removeItem(CONFIG.STORAGE_PREFIX + 'events');
    },

    // 获取用户统计
    getUserStats: () => {
      const key = CONFIG.STORAGE_PREFIX + 'user_stats';
      const defaultStats = {
        userId: utils.getUserId(),
        firstVisit: Date.now(),
        totalVisits: 0,
        totalPageViews: 0,
        featureUsage: {
          uploadResume: 0,
          uploadJD: 0,
          resumeDiagnosis: 0,
          jobRecommendation: 0,
          gapAnalysis: 0,
          aiInterview: 0,
        },
        pageStats: {},
      };
      return { ...defaultStats, ...(JSON.parse(localStorage.getItem(key) || '{}')) };
    },

    // 更新用户统计
    updateUserStats: (updater) => {
      const key = CONFIG.STORAGE_PREFIX + 'user_stats';
      const stats = storage.getUserStats();
      updater(stats);
      localStorage.setItem(key, JSON.stringify(stats));
    },
  };

  // ==================== 埋点核心 ====================
  const tracker = {
    // 当前页面数据
    currentPage: null,
    scrollDepths: new Set(),
    heartbeatTimer: null,

    // 初始化
    init: () => {
      const session = utils.getSessionId();
      const userId = utils.getUserId();

      // 更新用户访问统计
      storage.updateUserStats((stats) => {
        stats.totalVisits = session.visitCount;
        stats.totalPageViews++;
        stats.lastVisit = Date.now();
      });

      // 初始化当前页面数据
      tracker.currentPage = {
        pageName: utils.getPageName(),
        url: window.location.href,
        enterTime: Date.now(),
        leaveTime: null,
        duration: 0,
        maxScrollDepth: 0,
        deviceInfo: utils.getDeviceInfo(),
      };

      // 记录PV
      tracker.trackEvent('page_view', {
        pageName: tracker.currentPage.pageName,
        url: tracker.currentPage.url,
        sessionId: session.id,
        userId: userId,
        isNewSession: session.visitCount === 1,
      });

      // 绑定事件
      tracker.bindEvents();

      // 启动心跳
      tracker.startHeartbeat();

      console.log('[Analytics] Initialized', { userId, sessionId: session.id });
    },

    // 绑定事件监听
    bindEvents: () => {
      // 页面可见性变化（切换标签页）
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          tracker.trackEvent('page_hide', {
            pageName: tracker.currentPage.pageName,
            duration: Date.now() - tracker.currentPage.enterTime,
          });
        } else {
          tracker.trackEvent('page_show', {
            pageName: tracker.currentPage.pageName,
          });
        }
      });

      // 页面离开
      window.addEventListener('beforeunload', () => {
        tracker.trackPageLeave();
      });

      // 滚动深度
      window.addEventListener(
        'scroll',
        utils.throttle(() => {
          tracker.trackScrollDepth();
        }, 500)
      );

      // 点击事件委托
      document.addEventListener('click', (e) => {
        tracker.trackClick(e);
      });
    },

    // 追踪滚动深度
    trackScrollDepth: () => {
      const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
      const docHeight = document.documentElement.scrollHeight - document.documentElement.clientHeight;
      const scrollPercent = Math.round((scrollTop / docHeight) * 100);

      tracker.currentPage.maxScrollDepth = Math.max(tracker.currentPage.maxScrollDepth, scrollPercent);

      // 记录关键深度节点
      CONFIG.SCROLL_DEPTH_LEVELS.forEach((level) => {
        if (scrollPercent >= level && !tracker.scrollDepths.has(level)) {
          tracker.scrollDepths.add(level);
          tracker.trackEvent('scroll_depth', {
            pageName: tracker.currentPage.pageName,
            depth: level,
          });
        }
      });
    },

    // 追踪点击
    trackClick: (e) => {
      const target = e.target.closest('[data-track]') || e.target;
      const trackId = target.getAttribute('data-track') || target.id || target.className;

      if (trackId) {
        tracker.trackEvent('click', {
          pageName: tracker.currentPage.pageName,
          element: trackId,
          text: target.textContent?.trim()?.substring(0, 50) || '',
        });
      }
    },

    // 追踪页面离开
    trackPageLeave: () => {
      if (tracker.currentPage) {
        tracker.currentPage.leaveTime = Date.now();
        tracker.currentPage.duration = tracker.currentPage.leaveTime - tracker.currentPage.enterTime;

        tracker.trackEvent('page_leave', {
          pageName: tracker.currentPage.pageName,
          duration: tracker.currentPage.duration,
          maxScrollDepth: tracker.currentPage.maxScrollDepth,
        });
      }
      tracker.stopHeartbeat();
    },

    // 追踪自定义事件
    trackEvent: (eventType, data = {}) => {
      const event = {
        type: eventType,
        userId: utils.getUserId(),
        sessionId: utils.getSessionId().id,
        pageName: utils.getPageName(),
        ...data,
      };

      storage.saveEvent(event);

      // 同时输出到控制台（调试用）
      console.log('[Analytics]', eventType, data);
    },

    // 追踪功能使用
    trackFeature: (featureName, data = {}) => {
      // 更新用户统计
      const featureMap = {
        uploadResume: 'uploadResume',
        uploadJD: 'uploadJD',
        resumeDiagnosis: 'resumeDiagnosis',
        jobRecommendation: 'jobRecommendation',
        gapAnalysis: 'gapAnalysis',
        aiInterview: 'aiInterview',
      };

      if (featureMap[featureName]) {
        storage.updateUserStats((stats) => {
          stats.featureUsage[featureMap[featureName]]++;
        });
      }

      tracker.trackEvent('feature_use', {
        feature: featureName,
        ...data,
      });
    },

    // 心跳上报
    startHeartbeat: () => {
      tracker.heartbeatTimer = setInterval(() => {
        tracker.trackEvent('heartbeat', {
          pageName: tracker.currentPage.pageName,
          duration: Date.now() - tracker.currentPage.enterTime,
        });
      }, CONFIG.HEARTBEAT_INTERVAL);
    },

    stopHeartbeat: () => {
      if (tracker.heartbeatTimer) {
        clearInterval(tracker.heartbeatTimer);
        tracker.heartbeatTimer = null;
      }
    },
  };

  // ==================== 数据导出 API ====================
  const analyticsAPI = {
    // 初始化
    init: tracker.init,

    // 追踪事件
    track: tracker.trackEvent,

    // 追踪功能使用
    trackFeature: tracker.trackFeature,

    // 获取用户统计
    getUserStats: storage.getUserStats,

    // 获取所有事件
    getEvents: storage.getEvents,

    // 导出数据（用于分析）
    export: () => {
      return {
        userStats: storage.getUserStats(),
        events: storage.getEvents(),
        exportTime: Date.now(),
      };
    },

    // 清空数据
    clear: () => {
      storage.clearEvents();
      localStorage.removeItem(CONFIG.STORAGE_PREFIX + 'user_stats');
      console.log('[Analytics] Data cleared');
    },

    // 生成分析报告
    generateReport: () => {
      const stats = storage.getUserStats();
      const events = storage.getEvents();

      // 页面浏览统计
      const pageViews = {};
      const pageDurations = {};

      events.forEach((e) => {
        if (e.type === 'page_view') {
          pageViews[e.pageName] = (pageViews[e.pageName] || 0) + 1;
        }
        if (e.type === 'page_leave' && e.duration) {
          if (!pageDurations[e.pageName]) {
            pageDurations[e.pageName] = [];
          }
          pageDurations[e.pageName].push(e.duration);
        }
      });

      // 计算平均停留时间
      const avgDurations = {};
      Object.keys(pageDurations).forEach((page) => {
        const durations = pageDurations[page];
        avgDurations[page] = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 1000);
      });

      return {
        summary: {
          totalUsers: new Set(events.map((e) => e.userId)).size,
          totalEvents: events.length,
          totalPageViews: stats.totalPageViews,
        },
        featureUsage: stats.featureUsage,
        pageViews,
        avgDurations,
        rawEvents: events,
      };
    },
  };

  // ==================== 暴露到全局 ====================
  window.Analytics = analyticsAPI;

  // 自动初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', analyticsAPI.init);
  } else {
    analyticsAPI.init();
  }
})();
