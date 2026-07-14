package com.tiffpreview.config;

import com.github.benmanes.caffeine.cache.Caffeine;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

@Configuration
public class CacheConfig {

    @Bean
    public ConcurrentHashMap<String, byte[]> l1Cache() {
        return new ConcurrentHashMap<>();
    }

    @Bean
    public com.github.benmanes.caffeine.cache.Cache<String, byte[]> l2Cache() {
        return Caffeine.newBuilder()
                .maximumSize(200)
                .expireAfterAccess(30, TimeUnit.MINUTES)
                .recordStats()
                .build();
    }
}
