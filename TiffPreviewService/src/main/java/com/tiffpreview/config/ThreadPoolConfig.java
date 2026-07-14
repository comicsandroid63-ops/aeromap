package com.tiffpreview.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;

@Configuration
public class ThreadPoolConfig {

    @Bean
    public Semaphore tiffSemaphore() {
        return new Semaphore(4);
    }

    @Bean
    public ExecutorService tiffIoExecutor() {
        return Executors.newFixedThreadPool(
                Runtime.getRuntime().availableProcessors(),
                r -> {
                    Thread t = new Thread(r, "tiff-io-worker");
                    t.setDaemon(true);
                    return t;
                });
    }
}
